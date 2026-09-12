#!/usr/bin/env node
'use strict';
// PROCESS A — the generator. PLAN §3.3, §6.
//
// Emits a deterministic 32x4,000 Hz signal at the configured REAL-WORLD rate, paced against a
// monotonic clock, and hands it to the recorder over an AF_UNIX stream socket.
//
// The requirement this file exists to satisfy (R11): the generator must maintain its rate
// INDEPENDENTLY of the recorder's throughput or backpressure. Three layered mechanisms:
//   (1) the tick never awaits anything — not a 'drain' event, not a promise, not the socket's
//       health. Its runtime is a pure function of CPU cost.
//   (2) a preallocated bounded ring absorbs ~5 s of consumer stall.
//   (3) before every write the drain loop checks socket.writableLength, so Node's internally
//       UNBOUNDED Writable queue can never become a second, hidden, time-proportional buffer.
// On ring-full it drops the OLDEST block and records the exact (startFrameIndex, frameCount).

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { parseArgv } = require('../src/util/cli');
const { resolveConfig, describeConfig, ConfigError } = require('../src/config/config');
const { createSignal } = require('../src/signal/signal');
const { createScheduler } = require('../src/acquire/scheduler');
const { BlockRing } = require('../src/ring/block-ring');
const { DropLedger, CAUSE } = require('../src/acquire/drop-ledger');
const wire = require('../src/format/wire');
const { crc32c, crc32cUpdate, crc32cFinish } = require('../src/format/crc32c');
const { createLogger } = require('../src/util/logger');
const D = require('../src/config/defaults');
const { n } = require('../src/util/fmt');

const USAGE = `
sigacq generator — PROCESS A

  node bin/generator.js [options]

  --socket PATH            AF_UNIX socket to connect to (default /tmp/sigacq.sock)
  --sink null              generate and discard; measures pacing with no consumer at all
  --channels N             channel count            (default ${D.CHANNEL_COUNT})
  --rate HZ                samples/second/channel   (default ${D.SAMPLE_RATE_HZ})
  --duration S             stop after S seconds     (default 0 = until interrupted)
  --no-dither              disable the dither term  (visually cleaner traces)
  --gen-ring-blocks N      generator ring depth     (default ${D.GENERATOR_RING_BLOCKS})
  --stats-interval S       stats line period        (default ${D.STATS_INTERVAL_SECONDS}, 0 = off)
  --pacing-out PATH        write the pacing report as JSON on exit
  --quiet                  suppress info-level logs
  --help
`;

function main() {
  const { opts } = parseArgv(process.argv.slice(2), {
    booleans: ['dither', 'quiet', 'help', 'stats'],
    aliases: { c: 'channels', r: 'rate', d: 'duration' },
  });
  if (opts.help) return void process.stdout.write(USAGE);

  const cfg = resolveConfig({
    channelCount: opts.channels,
    sampleRateHz: opts.rate,
    dither: opts.dither,
    duration: opts.duration,
    generatorRingBlocks: opts.genRingBlocks,
    statsIntervalSeconds: opts.statsInterval,
    socketPath: opts.socket,
    config: opts.config,
  });
  const socketPath = cfg.socketPath ?? '/tmp/sigacq.sock';
  const toNull = opts.sink === 'null';
  const log = createLogger({ component: 'generator', quiet: !!opts.quiet });

  const signal = createSignal({ channelCount: cfg.channelCount, dither: cfg.dither });
  const ledger = new DropLedger();
  const ring = new BlockRing({ slots: cfg.generatorRingBlocks, slotBytes: cfg.wireBlockBytes });

  // One Float32Array over the ENTIRE ring, so a slot's payload is addressed by value index with no
  // per-tick view allocation. This is the reason the ring is non-pooled and alignment-checked.
  const ringF32 = new Float32Array(ring.buf.buffer, ring.buf.byteOffset, ring.buf.length / 4);

  let socket = null;
  let connected = false;
  let blocksWritten = 0;
  let bytesWritten = 0;
  let drainStalls = 0; // ticks on which the socket HWM stopped the drain loop
  let peakWritableLength = 0;
  let firstBlock = true;

  // ---- transport ----------------------------------------------------------------------------
  function connect() {
    if (toNull) return;
    socket = net.createConnection({ path: socketPath, writableHighWaterMark: D.SOCKET_HWM_BYTES });
    socket.on('connect', () => {
      connected = true;
      socket.setNoDelay?.(true);
      log.info('connected', { socketPath });
    });
    socket.on('error', (err) => {
      // Never fatal. A missing or crashed recorder must not stop the generator: the ring absorbs,
      // then the drop ledger accounts. That is the whole point of R11.
      connected = false;
      log.throttled('warn', 'socket-error', { code: err.code, message: err.message }, 2000);
    });
    socket.on('close', () => {
      connected = false;
      log.throttled('warn', 'socket-closed', { blocksWritten }, 2000);
      if (!stopping) setTimeout(connect, 250).unref(); // reconnect; the gap is reported by position
    });
  }

  // ---- the hot path -------------------------------------------------------------------------
  /** Called by the scheduler once per tick. Allocates nothing. Awaits nothing. */
  function onFrames(startFrameIndex, frameCount) {
    const off = ring.reserveOffset();
    const payloadBytes = frameCount * cfg.bytesPerFrame;

    wire.writeHeaderNoCrc(ring.buf, off, {
      startFrameIndex,
      frameCount,
      channelCount: cfg.channelCount,
      dtypeCode: cfg.dtypeCode,
      flags: firstBlock ? wire.FLAG.FIRST : 0,
      payloadBytes,
    });
    firstBlock = false;

    // Interleaved on the wire (PLAN §4.2): the recorder's gap detector wants whole frames as they
    // arrive. The transpose to planar happens once, in the recorder, which has the idle time.
    signal.fillInterleaved(ringF32, (off + wire.HEADER_BYTES) / 4, startFrameIndex, frameCount);

    // CRC over header[0,28) concatenated with the payload, computed in place with no copy.
    const state = crc32cUpdate(ring.buf, off, off + wire.OFF.crc32c);
    ring.buf.writeUInt32LE(
      crc32cFinish(crc32cUpdate(ring.buf, off + wire.HEADER_BYTES, off + wire.HEADER_BYTES + payloadBytes, state)),
      off + wire.OFF.crc32c
    );

    const victim = ring.commit(startFrameIndex, frameCount, wire.HEADER_BYTES + payloadBytes);
    if (victim) {
      // The ring was full: a block the generator PRODUCED never reached the recorder. Accounted by
      // exact position, never as a bare count.
      ledger.record(victim.startFrameIndex, victim.frameCount, CAUSE.GENERATOR_RING_FULL);
      log.throttled('warn', 'generator-ring-full', {
        startFrameIndex: victim.startFrameIndex,
        frameCount: victim.frameCount,
        totalDroppedFrames: ledger.totalDroppedFrames,
      });
    }
  }

  /**
   * Drain, run at the end of every tick. PLAN §3.3.
   * write()'s boolean return is deliberately IGNORED — the loop condition already encodes it, and
   * reacting to `false` by awaiting 'drain' is precisely the coupling R11 forbids.
   */
  function drain() {
    if (toNull) {
      while (ring.pop());
      return;
    }
    if (!connected || !socket || socket.destroyed || !socket.writable) return;
    let wrote = false;
    while (!ring.isEmpty) {
      const wl = socket.writableLength;
      if (wl > peakWritableLength) peakWritableLength = wl;
      if (wl >= D.SOCKET_HWM_BYTES) {
        drainStalls++;
        break;
      }
      const block = ring.peek();
      socket.write(block.bytes);
      bytesWritten += block.bytes.length;
      blocksWritten++;
      ring.pop();
      wrote = true;
    }
    return wrote;
  }

  const scheduler = createScheduler({
    rateHz: cfg.sampleRateHz,
    tickNanos: BigInt(cfg.tickNanos),
    onFrames,
    onTickEnd: drain,
    onResync: (startFrameIndex, frameCount) => {
      // The scheduler fell so far behind (a SIGSTOP, a closed lid) that catching up would be
      // meaningless. The skipped range is recorded as real, positioned loss rather than hidden as
      // drift.
      ledger.record(startFrameIndex, frameCount, CAUSE.PACING_RESYNC);
      log.warn('pacing-resync', { startFrameIndex, frameCount });
    },
  });

  // ---- lifecycle ----------------------------------------------------------------------------
  let stopping = false;
  let statsTimer = null;
  let durationTimer = null;

  function statsLine() {
    const r = scheduler.report();
    log.info('stats', {
      elapsedSeconds: +r.elapsedSeconds.toFixed(3),
      emittedFrames: r.emittedFrames,
      emittedValues: r.emittedFrames * cfg.channelCount,
      deviationFrames: r.deviationFrames,
      deviationPpm: r.deviationPpm,
      tickLagP99UsAtMost: r.tickLag.p99UsAtMost,
      tickLagMaxUs: r.tickLag.maxUs,
      ringFillPct: +(ring.fillFraction * 100).toFixed(2),
      ringPeakBlocks: ring.peakCount,
      droppedFrames: ledger.totalDroppedFrames,
      drainStalls,
      connected,
      rssMb: +(process.memoryUsage.rss() / 1048576).toFixed(1),
    });
  }

  function finish(code = 0) {
    if (stopping) return;
    stopping = true;
    scheduler.stop();
    if (statsTimer) clearInterval(statsTimer);
    if (durationTimer) clearTimeout(durationTimer);

    drain(); // one last attempt to hand over whatever the ring still holds
    const report = scheduler.report();
    const summary = {
      ...report,
      startTimestampUnixNanos: String(report.startTimestampUnixNanos),
      startMonotonicNanos: String(report.startMonotonicNanos),
      channelCount: cfg.channelCount,
      sampleRateHz: cfg.sampleRateHz,
      emittedValues: report.emittedFrames * cfg.channelCount,
      blocksWritten,
      bytesWritten,
      drainStalls,
      peakWritableLength,
      ringPeakBlocks: ring.peakCount,
      ringPeakFillPct: +((ring.peakCount / ring.slots) * 100).toFixed(2),
      drops: ledger.toJSON({ channelCount: cfg.channelCount, sampleRateHz: cfg.sampleRateHz }),
    };

    process.stderr.write(
      [
        '',
        '  generator — final pacing report',
        `    elapsed              ${report.elapsedSeconds.toFixed(3)} s`,
        `    emitted              ${n(report.emittedFrames)} frames = ${n(summary.emittedValues)} values`,
        `    expected (clock)     ${n(report.expectedFrames)} frames`,
        `    deviation            ${report.deviationFrames} frames (${report.deviationPpm} ppm)`,
        `    tick lag             p50 <= ${report.tickLag.p50UsAtMost} us, p99 <= ${report.tickLag.p99UsAtMost} us, max ${report.tickLag.maxUs} us`,
        `    late ticks           ${n(report.lateTicks)} of ${n(report.ticks)}`,
        `    pacing resyncs       ${report.resyncCount} (${n(report.resyncFrames)} frames)`,
        `    ring peak            ${ring.peakCount}/${ring.slots} blocks (${summary.ringPeakFillPct}%)`,
        `    drain stalls         ${n(drainStalls)}   peak socket queue ${n(peakWritableLength)} B`,
        `    dropped              ${n(ledger.totalDroppedFrames)} frames in ${ledger.count} range(s)`,
        '',
      ].join('\n')
    );

    if (opts.pacingOut) {
      fs.mkdirSync(path.dirname(opts.pacingOut), { recursive: true });
      fs.writeFileSync(opts.pacingOut, `${JSON.stringify(summary, null, 2)}\n`);
    }

    const done = () => process.exit(code);
    if (socket && !socket.destroyed) socket.end(done);
    else done();
    setTimeout(done, 500).unref(); // never hang on a dead socket
  }

  process.on('SIGINT', () => finish(0));
  process.on('SIGTERM', () => finish(0));

  log.info('start', {
    pid: process.pid,
    socketPath: toNull ? null : socketPath,
    sink: toNull ? 'null' : 'uds',
    channelCount: cfg.channelCount,
    sampleRateHz: cfg.sampleRateHz,
    framesPerTick: cfg.framesPerTick,
    wireBlockBytes: cfg.wireBlockBytes,
    valuesPerSecond: cfg.valuesPerSecond,
    ringBlocks: cfg.generatorRingBlocks,
    ringSeconds: +cfg.generatorRingSeconds.toFixed(3),
    dither: cfg.dither,
  });
  if (!opts.quiet) process.stderr.write(`${describeConfig(cfg)}\n`);

  connect();
  scheduler.start(0);
  if (cfg.statsIntervalSeconds > 0) {
    statsTimer = setInterval(statsLine, cfg.statsIntervalSeconds * 1000);
    statsTimer.unref();
  }
  if (cfg.duration > 0) durationTimer = setTimeout(() => finish(0), cfg.duration * 1000);
}

try {
  main();
} catch (e) {
  if (e instanceof ConfigError) {
    process.stderr.write(`configuration error: ${e.message}\n`);
    process.exit(64); // EX_USAGE
  }
  throw e;
}
