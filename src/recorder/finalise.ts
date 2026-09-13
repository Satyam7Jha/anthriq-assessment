// Clean shutdown, metadata first.
//
// F-02: a fixed timeout on a variable-latency operation guarantees the failure it exists to prevent.
// So: drain for a budget scaled to the write latency actually observed; if the disk has not caught
// up, stop writing payload, ledger every unwritten frame by position, and write the trailer and
// finalised header anyway. Losing the last seconds of payload but keeping an accurate ledger is
// strictly better than the reverse.

import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/config.ts';
import { DEFAULTS as D } from '../config/defaults.ts';
import * as fileHeader from '../format/file-header.ts';
import * as trailer from '../format/trailer.ts';
import type { FileHeaderInput } from '../format/file-header.ts';
import type { BlockWriter } from '../store/writer.ts';
import type { Ingest } from '../acquire/ingest.ts';
import { CAUSE, type DropLedger } from '../acquire/drop-ledger.ts';
import type { WireParser } from '../format/wire-parser.ts';
import type { Logger } from '../util/logger.ts';
import type { Telemetry } from './telemetry.ts';
import { n, bytes } from '../util/fmt.ts';

export interface FinaliseInput {
  cfg: Config;
  fd: number;
  outPath: string;
  header: FileHeaderInput;
  writer: BlockWriter;
  ingest: Ingest;
  ledger: DropLedger;
  parser: WireParser;
  telemetry: () => Telemetry;
  diskError: () => NodeJS.ErrnoException | null;
  log: Logger;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function finalise(x: FinaliseInput): Promise<void> {
  const { cfg, fd, writer, ingest, ledger } = x;

  const outstanding = Math.ceil(ingest.residentFrames / cfg.framesPerBlock) + writer.queuedBlocks + 1;
  const perBlockMs = Math.max(writer.writeLatencyMaxMs, writer.injectStallMs, 20);
  const budgetMs = Math.min(D.SHUTDOWN_DRAIN_MAX_MS, Math.max(D.SHUTDOWN_WATCHDOG_MS, outstanding * perBlockMs * 2));
  const watchdog = setTimeout(() => {
    process.stderr.write('shutdown watchdog fired\n');
    process.exit(1);
  }, budgetMs + D.SHUTDOWN_WATCHDOG_MS);
  watchdog.unref();

  const deadline = Date.now() + budgetMs;
  while (!x.diskError() && (ingest.segmentCount > 0 || writer.queuedBlocks > 0) && Date.now() < deadline) {
    if (!ingest.flushOne()) await sleep(2);
  }

  writer.close(); // nothing may be written at filePosition once the trailer goes there
  const unflushed = writer.unacknowledged();
  for (const r of unflushed) ledger.record(r.startFrameIndex, r.frameCount, CAUSE.SHUTDOWN_UNFLUSHED);
  if (ingest.segmentCount > 0) ingest.abandonRemaining(CAUSE.SHUTDOWN_UNFLUSHED);
  if (unflushed.length || ledger.totalDroppedFrames) x.log.warn('shutdown-accounting', { unflushedBlocks: unflushed.length, droppedFrames: ledger.totalDroppedFrames });

  const totalFrames = writer.totalFrames;
  let trailerOffset = 0;
  let trailerBytes = 0;
  if (!x.diskError()) {
    const t = trailer.encode(ledger.entries());
    [trailerOffset, trailerBytes] = [writer.filePosition, t.length];
    fs.writeSync(fd, t, 0, t.length, trailerOffset);
  }
  const finalHeader = fileHeader.encode({
    ...x.header,
    totalFrames,
    totalValues: totalFrames * cfg.channelCount,
    blockCount: writer.blocksWritten,
    durationSeconds: totalFrames / cfg.sampleRateHz,
    endTimestampUnixNanos: BigInt(Date.now()) * 1_000_000n,
    trailerOffset,
    trailerBytes,
    droppedFramesTotal: ledger.totalDroppedFrames,
    ledgerEntryCount: ledger.count,
    flags:
      (x.header.flags ?? 0) |
      fileHeader.FLAG.FINALISED |
      (trailerBytes ? fileHeader.FLAG.HAS_TRAILER : 0) |
      (ledger.totalDroppedFrames > 0 ? fileHeader.FLAG.HAD_DROPS : 0) |
      (ledger.truncated ? fileHeader.FLAG.LEDGER_TRUNCATED : 0),
  });
  fs.writeSync(fd, finalHeader, 0, D.FILE_HEADER_BYTES, 0);
  fs.fsyncSync(fd);
  fs.closeSync(fd);

  const stats = x.telemetry();
  const sizeBytes = fs.statSync(x.outPath).size;
  writeSidecar(x, finalHeader, totalFrames, sizeBytes, stats);
  process.stderr.write(report(x, totalFrames, sizeBytes, stats));
  clearTimeout(watchdog);
}

/** Human-readable mirror of the header, plus what a fixed binary schema cannot hold. Header wins on conflict. */
function writeSidecar(x: FinaliseInput, finalHeader: Buffer, totalFrames: number, sizeBytes: number, stats: Telemetry): void {
  const { cfg } = x;
  const sidecar = {
    recordingId: Buffer.from(x.header.recordingId).toString('hex'),
    binaryFile: path.basename(x.outPath),
    binarySizeBytes: sizeBytes,
    headerCrc32c: finalHeader.readUInt32LE(fileHeader.OFF.headerCrc32c),
    format: { magic: D.FILE_MAGIC, formatVersion: D.FORMAT_VERSION, layout: 'BLOCK_PLANAR', dtype: 'float32', byteOrder: 'little-endian', blockStrideBytes: cfg.blockStrideBytes },
    acquisition: {
      channelCount: cfg.channelCount,
      sampleRateHz: cfg.sampleRateHz,
      totalFrames,
      totalValues: totalFrames * cfg.channelCount,
      durationSeconds: totalFrames / cfg.sampleRateHz,
      startTimestampUnixNanos: String(x.header.startTimestampUnixNanos),
      signalId: x.header.signalId,
      dither: cfg.dither,
      finalised: true,
    },
    buffering: { ringBytes: cfg.ringBytes, ringSeconds: +cfg.ringSeconds.toFixed(2), ringPeakPct: stats.ringPeakPct, overflowPolicy: 'DROP_NEWEST_BLOCK', fsyncIntervalSeconds: cfg.fsyncIntervalSeconds },
    integrity: { gapFrames: x.parser.stats.gapFrames, duplicateFrames: x.parser.stats.duplicateFrames, crcFailures: x.parser.stats.crcFailures },
    drops: x.ledger.toJSON({ channelCount: cfg.channelCount, sampleRateHz: cfg.sampleRateHz }),
    config: Object.fromEntries(Object.entries(cfg.sources).map(([k, source]) => [k, { value: cfg[k as keyof Config], source }])),
  };
  fs.writeFileSync(x.outPath.replace(/\.sigb$/, '') + '.json', `${JSON.stringify(sidecar, null, 2)}\n`);
}

function report(x: FinaliseInput, totalFrames: number, sizeBytes: number, stats: Telemetry): string {
  const { cfg, writer, parser, ledger } = x;
  return [
    '',
    '  recorder — final report',
    `    file                 ${x.outPath}`,
    `    size                 ${n(sizeBytes)} B  (${bytes(sizeBytes)})`,
    `    frames               ${n(totalFrames)}  =  ${n(totalFrames * cfg.channelCount)} values`,
    `    duration             ${(totalFrames / cfg.sampleRateHz).toFixed(3)} s`,
    `    blocks               ${n(writer.blocksWritten)}`,
    `    ring peak            ${stats.ringPeakPct}% of ${bytes(cfg.ringBytes)} (${cfg.ringSeconds.toFixed(1)} s capacity)`,
    `    write latency max    ${writer.writeLatencyMaxMs.toFixed(2)} ms`,
    `    fsyncs               ${writer.fsyncCount} (max ${writer.fsyncMaxMs.toFixed(2)} ms)`,
    `    gaps / duplicates    ${parser.stats.gapFrames} / ${parser.stats.duplicateFrames} frames`,
    `    crc failures         ${parser.stats.crcFailures}`,
    `    dropped              ${n(ledger.totalDroppedFrames)} frames in ${ledger.count} range(s)`,
    '    finalised            yes',
    '',
    '',
  ].join('\n');
}
