#!/usr/bin/env node
'use strict';
// PROCESS B — the recorder. PLAN §7.
//
// Owns the durable resource (the file) and therefore owns the socket lifecycle: it is the SERVER,
// the generator is the client. That direction matters — the generator can start, crash and
// reconnect without the recording being closed, and the reconnect surfaces as a gap at an exact
// position rather than as a truncated file.
//
// Memory contract: every allocation happens BEFORE the first byte is accepted. The ring is
// preallocated, the two block-assembly buffers are preallocated, the parser's carry buffer is
// preallocated, and the drop ledger is a preallocated typed-array pair with a hard cap. Nothing in
// the steady state allocates per block, so recorder RSS has no term proportional to run duration.

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseArgv } = require('../src/util/cli');
const { resolveConfig, describeConfig, ConfigError } = require('../src/config/config');
const { ByteRing } = require('../src/ring/byte-ring');
const { WireParser } = require('../src/format/wire-parser');
const { BlockWriter } = require('../src/store/writer');
const { createIngest } = require('../src/acquire/ingest');
const { DropLedger, CAUSE } = require('../src/acquire/drop-ledger');
const fileHeader = require('../src/format/file-header');
const trailer = require('../src/format/trailer');
const { createLogger } = require('../src/util/logger');
const { n, bytes: fmtBytes } = require('../src/util/fmt');
const D = require('../src/config/defaults');

const USAGE = `
sigacq recorder — PROCESS B

  node bin/recorder.js --out FILE [options]

  --out PATH               output .sigb path (required)
  --socket PATH            AF_UNIX socket to listen on (default /tmp/sigacq.sock)
  --channels N             expected channel count   (default ${D.CHANNEL_COUNT})
  --rate HZ                expected sample rate     (default ${D.SAMPLE_RATE_HZ})
  --duration S             stop after S seconds     (default 0 = until interrupted)
  --ring-bytes N           bounded ring size        (default ${D.RECORDER_RING_BYTES})
  --frames-per-block N     file block size in frames(default ${D.FRAMES_PER_FILE_BLOCK})
  --fsync-interval S       fsync period, 0 = never  (default ${D.FSYNC_INTERVAL_SECONDS})
  --stats-interval S       stats line period        (default ${D.STATS_INTERVAL_SECONDS})
  --stats-out PATH         append stats as NDJSON (the UI health panel tails this)
  --no-dither              record that the source had dither disabled
  --description TEXT       free text into the file header
  --inject-write-stall-ms N  fault injection: delay every disk write by N ms (slow-disk test)
  --quiet
  --help
`;

async function main() {
  const { opts } = parseArgv(process.argv.slice(2), {
    booleans: ['dither', 'quiet', 'help'],
    aliases: { o: 'out', c: 'channels', r: 'rate', d: 'duration' },
  });
  if (opts.help) return void process.stdout.write(USAGE);
  if (!opts.out) {
    process.stderr.write('error: --out FILE is required\n' + USAGE);
    process.exit(64);
  }

  const cfg = resolveConfig({
    channelCount: opts.channels,
    sampleRateHz: opts.rate,
    dither: opts.dither,
    duration: opts.duration,
    ringBytes: opts.ringBytes,
    framesPerBlock: opts.framesPerBlock,
    fsyncIntervalSeconds: opts.fsyncInterval,
    statsIntervalSeconds: opts.statsInterval,
    socketPath: opts.socket,
    description: opts.description,
    config: opts.config,
  });
  const socketPath = cfg.socketPath ?? '/tmp/sigacq.sock';
  const outPath = path.resolve(String(opts.out));
  const log = createLogger({ component: 'recorder', quiet: !!opts.quiet });

  // ---- preallocate EVERYTHING before accepting a byte -----------------------------------------
  const ring = new ByteRing({ bytes: cfg.ringBytes });
  const ledger = new DropLedger();
  const recordingId = crypto.randomBytes(16);
  const startWallNanos = BigInt(Date.now()) * 1_000_000n;
  const startMonoNanos = process.hrtime.bigint();
  // Staging buffer for one file block's worth of interleaved frames, pulled out of the ring in one
  // copy. One buffer, reused forever.
  const stage = Buffer.allocUnsafeSlow(cfg.blockPayloadBytes);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const fd = fs.openSync(outPath, 'w');

  const headerFields = {
    recordingId,
    channelCount: cfg.channelCount,
    sampleRateHz: cfg.sampleRateHz,
    sampleRateExactHz: cfg.sampleRateHz,
    dtypeCode: cfg.dtypeCode,
    bytesPerValue: cfg.bytesPerValue,
    layoutCode: D.LAYOUT_BLOCK_PLANAR,
    framesPerBlock: cfg.framesPerBlock,
    blockStrideBytes: cfg.blockStrideBytes,
    startTimestampUnixNanos: startWallNanos,
    startMonotonicNanos: startMonoNanos,
    ringBytes: cfg.ringBytes,
    fsyncIntervalSeconds: cfg.fsyncIntervalSeconds,
    generatorTickNanos: cfg.tickNanos,
    signalId: require('../src/config/defaults').SIGNAL_ID,
    producer: `sigacq 1.0.0 node-${process.version} ${process.platform}-${process.arch}`,
    description: cfg.description,
    flags: cfg.dither ? 0 : fileHeader.FLAG.DITHER_DISABLED,
  };
  // Write the header at t=0 with placeholder totals and FINALISED clear. It is rewritten at
  // shutdown. The FINALISED bit is what tells every reader whether to trust totalFrames or to
  // reconstruct it from the file length (PLAN §8.6) — which is what makes a SIGKILLed file readable.
  fs.writeSync(fd, fileHeader.encode(headerFields), 0, D.FILE_HEADER_BYTES, 0);

  let ingest = null; // created below; the writer's callback only runs after it exists
  const writer = new BlockWriter({
    fd,
    cfg,
    injectStallMs: Number(opts.injectWriteStallMs ?? 0),
    // When a write completes the writer can take another block. Pull from the ring here rather than
    // queueing inside the writer: backlog must live in the ring, where it is bounded and measured.
    onWritten: () => {
      if (!stopping && !diskError) ingest.drain();
    },
    onError: (err) => {
      log.error('write-failed', { code: err.code, message: err.message });
      diskError = err;
      void finish(err.code === 'ENOSPC' ? 1 : 1);
    },
  });

  // ---- ingest ---------------------------------------------------------------------------------
  // Accepted wire blocks -> bounded ring -> file blocks. Lives in src/acquire/ingest.js so the
  // frame-index bookkeeping can be unit-tested; see that file for why every gap, including one this
  // recorder creates by dropping, is measured against the last frame actually accepted.
  let diskError = null;
  let stopping = false;
  let connections = 0;
  ingest = createIngest({ cfg, ring, writer, ledger, stage, log });

  const parser = new WireParser({
    maxBlockBytes: Math.max(cfg.wirePayloadBytes * 8, 1 << 20),
    onBlock: (hdr, buf, payloadOffset) => {
      if (stopping || diskError) return;
      if (!ingest.onBlock(hdr, buf, payloadOffset)) return;
      const transition = ring.updateLevel();
      if (transition) {
        log.throttled(transition === 'HIGH' ? 'warn' : 'info', `ring-${transition.toLowerCase()}`, {
          fillPct: +(ring.fillFraction * 100).toFixed(1),
          headroomSeconds: +(ring.free / cfg.bytesPerSecond).toFixed(1),
          frameIndex: hdr.startFrameIndex,
        });
      }
    },
    onGap: (startFrameIndex, frameCount) => {
      ledger.record(startFrameIndex, frameCount, CAUSE.TRANSPORT_GAP);
      log.warn('gap', { startFrameIndex, frameCount, startValueIndex: startFrameIndex * cfg.channelCount });
    },
    onDuplicate: (startFrameIndex, frameCount) => {
      log.warn('duplicate', { startFrameIndex, frameCount });
    },
    onCorrupt: (bytesSkipped, reason) => {
      log.throttled('warn', 'corrupt-bytes', { bytesSkipped, reason });
    },
  });

  // ---- socket --------------------------------------------------------------------------------
  try {
    fs.unlinkSync(socketPath);
  } catch {
    /* no stale socket to remove */
  }
  const server = net.createServer((socket) => {
    connections++;
    log.info('generator-connected', { connections });
    socket.on('data', (chunk) => parser.push(chunk));
    socket.on('error', (err) => log.warn('socket-error', { code: err.code }));
    socket.on('close', () => {
      log.info('generator-disconnected', { framesReceived: parser.stats.frames });
      if (!stopping && cfg.duration === 0) {
        // The generator going away is not an error and must not end the recording: it may be
        // restarting, and the reconnect's gap will be reported by position.
      }
    });
  });
  server.listen(socketPath, () => log.info('listening', { socketPath, pid: process.pid }));

  // ---- periodic work --------------------------------------------------------------------------
  let lastFsyncMs = Date.now();
  const statsOut = opts.statsOut ? fs.createWriteStream(String(opts.statsOut), { flags: 'a' }) : null;

  async function maybeFsync() {
    if (cfg.fsyncIntervalSeconds <= 0 || stopping || diskError) return;
    if (Date.now() - lastFsyncMs < cfg.fsyncIntervalSeconds * 1000) return;
    // Defer while the ring is above the ELEVATED watermark: fsync on APFS can block for tens of
    // milliseconds, and sync must never be the thing that causes an overflow.
    if (ring.fillFraction >= 0.25) return;
    lastFsyncMs = Date.now();
    const ms = await writer.fsync();
    log.info('fsync', { ms: +ms.toFixed(2), blocksWritten: writer.blocksWritten });
  }

  function snapshot() {
    return {
      t: Date.now(),
      elapsedSeconds: +(Number(process.hrtime.bigint() - startMonoNanos) / 1e9).toFixed(3),
      framesReceived: parser.stats.frames,
      valuesReceived: parser.stats.frames * cfg.channelCount,
      blocksWritten: writer.blocksWritten,
      bytesWritten: writer.bytesWritten,
      ringFillPct: +(ring.fillFraction * 100).toFixed(2),
      ringPeakPct: +((ring.peakUsed / ring.capacity) * 100).toFixed(2),
      ringHeadroomSeconds: +(ring.free / cfg.bytesPerSecond).toFixed(1),
      ringLevel: ring.level,
      queuedBlocks: writer.queuedBlocks,
      writeLatencyMaxMs: +writer.writeLatencyMaxMs.toFixed(2),
      fsyncCount: writer.fsyncCount,
      fsyncMaxMs: +writer.fsyncMaxMs.toFixed(2),
      gaps: parser.stats.gaps,
      gapFrames: parser.stats.gapFrames,
      duplicateFrames: parser.stats.duplicateFrames,
      crcFailures: parser.stats.crcFailures,
      corruptBytes: parser.stats.corruptBytes,
      droppedFrames: ledger.totalDroppedFrames,
      droppedRanges: ledger.count,
      rssBytes: process.memoryUsage.rss(),
      heapUsedBytes: process.memoryUsage().heapUsed,
    };
  }

  const tickTimer = setInterval(() => void maybeFsync(), 1000);
  tickTimer.unref();
  let statsTimer = null;
  if (cfg.statsIntervalSeconds > 0) {
    statsTimer = setInterval(() => {
      const s = snapshot();
      log.info('stats', { ...s, rssMb: +(s.rssBytes / 1048576).toFixed(1) });
      // The UI health panel tails this file read-only — no socket, no IPC, so telemetry cannot
      // become a backpressure path either (PLAN §11.10).
      if (statsOut) statsOut.write(`${JSON.stringify(s)}\n`);
    }, cfg.statsIntervalSeconds * 1000);
    statsTimer.unref();
  }

  // ---- clean shutdown (PLAN §7.7) --------------------------------------------------------------
  let finishing = false;
  async function finish(code = 0) {
    if (finishing) {
      log.warn('second-signal', { note: 'forcing exit' });
      process.exit(130);
    }
    finishing = true;
    stopping = true;
    let step = 'begin';
    // F-02. A fixed timeout on a variable-latency operation guarantees the failure it exists to
    // prevent: on a stalled disk it used to fire mid-drain and exit before the ledger reached disk.
    // Now the order is: drain for a budget scaled to the latency actually observed; if the disk has
    // not caught up, stop writing payload, account every unwritten frame as a positioned loss, and
    // write the trailer and finalised header anyway. Losing the last seconds of payload while keeping
    // an accurate ledger is strictly better than the reverse.
    let watchdog = null;
    const armWatchdog = (ms) => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        process.stderr.write(`shutdown watchdog fired during step "${step}"\n`);
        process.exit(1);
      }, ms);
      watchdog.unref();
    };

    try {
      step = 'close-server';
      server.close();
      clearInterval(tickTimer);
      if (statsTimer) clearInterval(statsTimer);

      step = 'drain-writes';
      const blocksOutstanding = Math.ceil(ingest.residentFrames / cfg.framesPerBlock) + writer.queuedBlocks + 1;
      const perBlockMs = Math.max(writer.writeLatencyMaxMs, writer.injectStallMs, 20);
      const budgetMs = Math.min(D.SHUTDOWN_DRAIN_MAX_MS, Math.max(D.SHUTDOWN_WATCHDOG_MS, blocksOutstanding * perBlockMs * 2));
      armWatchdog(budgetMs + D.SHUTDOWN_WATCHDOG_MS);
      const deadline = Date.now() + budgetMs;
      while (!diskError && (ingest.segmentCount > 0 || writer.queuedBlocks > 0) && Date.now() < deadline) {
        if (!ingest.flushOne()) await new Promise((r) => setTimeout(r, 2));
      }

      step = 'account-unflushed';
      writer.close(); // nothing may be written at filePosition once the trailer goes there
      const unflushed = [...writer.unacknowledged()];
      for (const r of unflushed) ledger.record(r.startFrameIndex, r.frameCount, CAUSE.SHUTDOWN_UNFLUSHED);
      if (ingest.segmentCount > 0) ingest.abandonRemaining(CAUSE.SHUTDOWN_UNFLUSHED);
      if (unflushed.length || ledger.totalDroppedFrames) {
        log.warn('shutdown-accounting', { unflushedBlocks: unflushed.length, droppedFrames: ledger.totalDroppedFrames });
      }

      const totalFrames = writer.totalFrames;
      const totalValues = totalFrames * cfg.channelCount;

      step = 'write-trailer';
      let trailerOffset = 0;
      let trailerBytes = 0;
      if (!diskError) {
        const tbuf = trailer.encode(ledger.entries());
        trailerOffset = writer.filePosition;
        trailerBytes = tbuf.length;
        fs.writeSync(fd, tbuf, 0, tbuf.length, trailerOffset);
      }

      step = 'finalise-header';
      const finalFlags =
        headerFields.flags |
        fileHeader.FLAG.FINALISED |
        (trailerBytes ? fileHeader.FLAG.HAS_TRAILER : 0) |
        (ledger.totalDroppedFrames > 0 ? fileHeader.FLAG.HAD_DROPS : 0) |
        (ledger.truncated ? fileHeader.FLAG.LEDGER_TRUNCATED : 0);
      const finalHeader = fileHeader.encode({
        ...headerFields,
        totalFrames,
        totalValues,
        blockCount: writer.blocksWritten,
        durationSeconds: totalFrames / cfg.sampleRateHz,
        endTimestampUnixNanos: BigInt(Date.now()) * 1_000_000n,
        trailerOffset,
        trailerBytes,
        flags: finalFlags,
        droppedFramesTotal: ledger.totalDroppedFrames,
        ledgerEntryCount: ledger.count,
      });
      fs.writeSync(fd, finalHeader, 0, D.FILE_HEADER_BYTES, 0);

      step = 'fsync';
      fs.fsyncSync(fd);
      step = 'close';
      fs.closeSync(fd);

      step = 'sidecar';
      const stats = snapshot();
      const sidecar = {
        recordingId: recordingId.toString('hex'),
        binaryFile: path.basename(outPath),
        binarySizeBytes: fs.statSync(outPath).size,
        headerCrc32c: finalHeader.readUInt32LE(fileHeader.OFF.headerCrc32c),
        format: {
          magic: D.FILE_MAGIC,
          formatVersion: D.FORMAT_VERSION,
          headerBytes: D.FILE_HEADER_BYTES,
          blockHeaderBytes: D.BLOCK_HEADER_BYTES,
          blockStrideBytes: cfg.blockStrideBytes,
          layout: 'BLOCK_PLANAR',
          dtype: 'float32',
          bytesPerValue: cfg.bytesPerValue,
          byteOrder: 'little-endian',
        },
        acquisition: {
          channelCount: cfg.channelCount,
          sampleRateHz: cfg.sampleRateHz,
          framesPerBlock: cfg.framesPerBlock,
          totalFrames,
          totalValues,
          durationSeconds: totalFrames / cfg.sampleRateHz,
          startTimestampUnixNanos: String(startWallNanos),
          startTimestampIso: new Date(Number(startWallNanos / 1_000_000n)).toISOString(),
          signalId: headerFields.signalId,
          dither: cfg.dither,
          finalised: true,
        },
        buffering: {
          ringBytes: cfg.ringBytes,
          ringSeconds: +cfg.ringSeconds.toFixed(2),
          ringPeakPct: stats.ringPeakPct,
          overflowPolicy: 'DROP_NEWEST_BLOCK',
          fsyncIntervalSeconds: cfg.fsyncIntervalSeconds,
        },
        integrity: {
          gaps: parser.stats.gaps,
          gapFrames: parser.stats.gapFrames,
          duplicateFrames: parser.stats.duplicateFrames,
          crcFailures: parser.stats.crcFailures,
          corruptBytes: parser.stats.corruptBytes,
        },
        drops: ledger.toJSON({ channelCount: cfg.channelCount, sampleRateHz: cfg.sampleRateHz }),
        producer: headerFields.producer,
        config: Object.fromEntries(Object.entries(cfg.sources).map(([k, v]) => [k, { value: cfg[k], source: v }])),
      };
      fs.writeFileSync(outPath.replace(/\.sigb$/, '') + '.json', `${JSON.stringify(sidecar, null, 2)}\n`);

      step = 'unlink-socket';
      try {
        fs.unlinkSync(socketPath);
      } catch {
        /* already gone */
      }
      if (statsOut) statsOut.end();

      process.stderr.write(
        [
          '',
          '  recorder — final report',
          `    file                 ${outPath}`,
          `    size                 ${n(sidecar.binarySizeBytes)} B  (${fmtBytes(sidecar.binarySizeBytes)})`,
          `    frames               ${n(totalFrames)}  =  ${n(totalValues)} values`,
          `    duration             ${(totalFrames / cfg.sampleRateHz).toFixed(3)} s`,
          `    blocks               ${n(writer.blocksWritten)}`,
          `    ring peak            ${stats.ringPeakPct}% of ${fmtBytes(cfg.ringBytes)} (${cfg.ringSeconds.toFixed(1)} s capacity)`,
          `    write latency max    ${writer.writeLatencyMaxMs.toFixed(2)} ms`,
          `    fsyncs               ${writer.fsyncCount} (max ${writer.fsyncMaxMs.toFixed(2)} ms)`,
          `    gaps / duplicates    ${parser.stats.gapFrames} / ${parser.stats.duplicateFrames} frames`,
          `    crc failures         ${parser.stats.crcFailures}`,
          `    dropped              ${n(ledger.totalDroppedFrames)} frames in ${ledger.count} range(s)`,
          `    finalised            yes`,
          '',
        ].join('\n')
      );
      clearTimeout(watchdog);
      process.exit(diskError ? 1 : code);
    } catch (e) {
      process.stderr.write(`shutdown failed during "${step}": ${e.stack}\n`);
      process.exit(1);
    }
  }

  process.on('SIGINT', () => void finish(0));
  process.on('SIGTERM', () => void finish(0));

  log.info('start', {
    pid: process.pid,
    out: outPath,
    socketPath,
    channelCount: cfg.channelCount,
    sampleRateHz: cfg.sampleRateHz,
    ringBytes: cfg.ringBytes,
    ringSeconds: +cfg.ringSeconds.toFixed(2),
    framesPerBlock: cfg.framesPerBlock,
    blockStrideBytes: cfg.blockStrideBytes,
    bytesPerSecond: cfg.bytesPerSecond,
  });
  if (!opts.quiet) process.stderr.write(`${describeConfig(cfg)}\n`);
  if (cfg.duration > 0) setTimeout(() => void finish(0), cfg.duration * 1000);
}

main().catch((e) => {
  if (e instanceof ConfigError) {
    process.stderr.write(`configuration error: ${e.message}\n`);
    process.exit(64);
  }
  process.stderr.write(`${e.stack}\n`);
  process.exit(1);
});
