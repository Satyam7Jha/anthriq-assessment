// PROCESS A — the generator: the deterministic signal at the configured real-world rate,
// paced on a monotonic clock, handed to the recorder over an AF_UNIX socket.
//
// Its rate must not depend on the recorder. The tick awaits nothing; a bounded ring absorbs
// ~5 s of consumer stall; when it is full the oldest block is dropped and its position ledgered.

import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/config.ts';
import { createSignal } from '../signal/signal.ts';
import { createScheduler } from '../acquire/scheduler.ts';
import { BlockRing } from '../ring/block-ring.ts';
import { DropLedger, CAUSE } from '../acquire/drop-ledger.ts';
import * as wire from '../format/wire.ts';
import { crc32cFinish, crc32cUpdate } from '../format/crc32c.ts';
import type { Logger } from '../util/logger.ts';
import { createSender } from './sender.ts';
import { formatPacingReport } from './report.ts';

export interface GeneratorOptions {
  cfg: Config;
  /** null for --sink null. */
  socketPath: string | null;
  pacingOut?: string;
  log: Logger;
}

export function runGenerator({ cfg, socketPath, pacingOut, log }: GeneratorOptions): void {
  const signal = createSignal({ channelCount: cfg.channelCount, dither: cfg.dither });
  const ledger = new DropLedger();
  const ring = new BlockRing(cfg.generatorRingBlocks, cfg.wireBlockBytes);
  // One Float32Array over the whole ring, so a slot's payload needs no per-tick view.
  const ringF32 = new Float32Array(ring.buf.buffer, ring.buf.byteOffset, ring.buf.length / 4);
  const sender = createSender({ socketPath, ring, wireBlockBytes: cfg.wireBlockBytes, log });
  let firstBlock = true;

  /** Once per tick. Allocates nothing, awaits nothing. */
  function onFrames(startFrameIndex: number, frameCount: number): void {
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
    // Interleaved on the wire: the recorder's gap detector wants whole frames.
    signal.fillInterleaved(ringF32, (off + wire.HEADER_BYTES) / 4, startFrameIndex, frameCount);
    const state = crc32cUpdate(ring.buf, off, off + wire.OFF.crc32c);
    ring.buf.writeUInt32LE(crc32cFinish(crc32cUpdate(ring.buf, off + wire.HEADER_BYTES, off + wire.HEADER_BYTES + payloadBytes, state)), off + wire.OFF.crc32c);

    const victim = ring.commit(startFrameIndex, frameCount, wire.HEADER_BYTES + payloadBytes);
    if (victim) {
      ledger.record(victim.startFrameIndex, victim.frameCount, CAUSE.GENERATOR_RING_FULL);
      log.throttled('warn', 'generator-ring-full', { ...victim, totalDroppedFrames: ledger.totalDroppedFrames });
    }
  }

  const scheduler = createScheduler({
    rateHz: cfg.sampleRateHz,
    tickNanos: BigInt(cfg.tickNanos),
    onFrames,
    onTickEnd: sender.drain,
    onResync: (startFrameIndex, frameCount) => {
      // So far behind (SIGSTOP, closed lid) that catching up is meaningless: ledger it, don't hide it.
      ledger.record(startFrameIndex, frameCount, CAUSE.PACING_RESYNC);
      log.warn('pacing-resync', { startFrameIndex, frameCount });
    },
  });

  const summary = () => {
    const r = scheduler.report();
    return {
      ...r,
      startTimestampUnixNanos: String(r.startTimestampUnixNanos),
      startMonotonicNanos: String(r.startMonotonicNanos),
      channelCount: cfg.channelCount,
      emittedValues: r.emittedFrames * cfg.channelCount,
      ...sender.stats,
      ringPeakBlocks: ring.peakCount,
      ringSlots: ring.slots,
      ringPeakFillPct: +((ring.peakCount / ring.slots) * 100).toFixed(2),
      ringFillPct: +(ring.fillFraction * 100).toFixed(2),
      droppedFrames: ledger.totalDroppedFrames,
      droppedRanges: ledger.count,
      drops: ledger.toJSON({ channelCount: cfg.channelCount, sampleRateHz: cfg.sampleRateHz }),
    };
  };

  let stopping = false;
  let statsTimer: NodeJS.Timeout | null = null;

  function finish(): void {
    if (stopping) return;
    stopping = true;
    scheduler.stop();
    if (statsTimer) clearInterval(statsTimer);
    sender.drain(); // one last attempt to hand over what the ring holds
    const s = summary();
    process.stderr.write(formatPacingReport(s));
    if (pacingOut) {
      fs.mkdirSync(path.dirname(pacingOut), { recursive: true });
      fs.writeFileSync(pacingOut, `${JSON.stringify(s, null, 2)}\n`);
    }
    const exit = () => process.exit(0);
    sender.close(exit);
    setTimeout(exit, 500).unref(); // never hang on a dead socket
  }

  process.on('SIGINT', finish);
  process.on('SIGTERM', finish);
  log.info('start', {
    pid: process.pid,
    socketPath,
    channelCount: cfg.channelCount,
    sampleRateHz: cfg.sampleRateHz,
    framesPerTick: cfg.framesPerTick,
    ringSeconds: +cfg.generatorRingSeconds.toFixed(3),
    stagingSlots: sender.stagingSlots,
  });

  sender.connect();
  scheduler.start(0);
  if (cfg.statsIntervalSeconds > 0) {
    statsTimer = setInterval(() => {
      const { drops: _drops, ...s } = summary();
      log.info('stats', s);
    }, cfg.statsIntervalSeconds * 1000);
    statsTimer.unref();
  }
  if (cfg.duration > 0) setTimeout(finish, cfg.duration * 1000);
}
