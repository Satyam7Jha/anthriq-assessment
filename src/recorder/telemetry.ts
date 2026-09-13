// The recorder's periodic stats: logged, appended as NDJSON for the viewer, and used in the sidecar.

import type { Config } from '../config/config.ts';
import type { ByteRing } from '../ring/byte-ring.ts';
import type { WireParser } from '../format/wire-parser.ts';
import type { BlockWriter } from '../store/writer.ts';
import type { DropLedger } from '../acquire/drop-ledger.ts';

export interface TelemetrySources {
  startMonoNanos: bigint;
  parser: WireParser;
  writer: BlockWriter;
  ring: ByteRing;
  ledger: DropLedger;
  cfg: Config;
}

export function snapshot({ startMonoNanos, parser, writer, ring, ledger, cfg }: TelemetrySources) {
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
    gapFrames: parser.stats.gapFrames,
    duplicateFrames: parser.stats.duplicateFrames,
    crcFailures: parser.stats.crcFailures,
    droppedFrames: ledger.totalDroppedFrames,
    droppedRanges: ledger.count,
    rssBytes: process.memoryUsage.rss(),
  };
}

export type Telemetry = ReturnType<typeof snapshot>;
