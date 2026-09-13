// `sigctl info` — metadata inspection (R30).

import fs from 'node:fs';
import type { Recording } from '../store/recover.ts';
import { readLedger } from '../store/recover.ts';
import { n, bytes, duration } from '../util/fmt.ts';

const iso = (ns: bigint): string => new Date(Number(ns / 1_000_000n)).toISOString();

export function info(rec: Recording, { json = false } = {}): number {
  const { hdr, extent, fileSize, filePath } = rec;
  const ledger = readLedger(rec);
  const sidecarPath = filePath.replace(/\.sigb$/, '') + '.json';
  let sidecarMatches: boolean | null = null;
  if (fs.existsSync(sidecarPath)) {
    try {
      // If sidecar and header disagree, the embedded header wins and the reader warns (FORMAT.md §9).
      sidecarMatches = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')).recordingId === hdr.recordingId;
    } catch {
      sidecarMatches = false;
    }
  }

  if (json) {
    const plain = JSON.parse(JSON.stringify(hdr, (_k, v) => (typeof v === 'bigint' ? String(v) : v)));
    process.stdout.write(`${JSON.stringify({ file: filePath, fileSizeBytes: fileSize, header: plain, extent, ledger: ledger.entries, sidecarMatches }, null, 2)}\n`);
    return 0;
  }

  const seconds = extent.totalFrames / hdr.sampleRateExactHz;
  const rows: [string, string][] = [
    ['file', filePath],
    ['size', `${n(fileSize)} B  (${bytes(fileSize)})`],
    ['format', `${hdr.magic} v${hdr.formatVersion}   header ${hdr.headerBytes} B   block header ${hdr.blockHeaderBytes} B`],
    ['recordingId', hdr.recordingId],
    ['', ''],
    ['channelCount', n(hdr.channelCount)],
    ['sampleRateHz', `${n(hdr.sampleRateHz)}  (exact ${hdr.sampleRateExactHz})`],
    ['dataType', `${hdr.dtypeName}  ${hdr.bytesPerValue} bytes/value  little-endian`],
    ['layout', `${hdr.layoutName}  (planar within a ${n(hdr.framesPerBlock)}-frame block)`],
    ['blockStrideBytes', n(hdr.blockStrideBytes)],
    ['', ''],
    ['totalFrames', n(extent.totalFrames)],
    ['totalValues (samples)', n(extent.totalValues)],
    ['duration', `${seconds.toFixed(6)} s   (${duration(seconds)})`],
    ['blockCount', n(extent.blockCount)],
    ['startTimestamp', `${iso(hdr.startTimestampUnixNanos)}  (${hdr.startTimestampUnixNanos} ns unix)`],
    ['endTimestamp', hdr.endTimestampUnixNanos ? iso(hdr.endTimestampUnixNanos) : '(not finalised)'],
    ['', ''],
    ['finalised', hdr.finalised ? 'yes' : 'NO — totals reconstructed from the file length'],
    ['recoveryUsed', extent.recovered ? `yes — ${n(extent.truncatedTailBytes)} trailing bytes ignored` : 'no'],
    ['signalId', hdr.signalId],
    ['ringBytes', `${n(hdr.ringBytes)}  (${(hdr.ringBytes / (hdr.channelCount * hdr.sampleRateExactHz * hdr.bytesPerValue)).toFixed(1)} s of absorption)`],
    ['fsyncInterval', `${hdr.fsyncIntervalSeconds} s  (bounds data at risk on an unclean kill)`],
    ['producer', hdr.producer],
    ['', ''],
    ['droppedValues', n(hdr.droppedFramesTotal * hdr.channelCount)],
    ['ledgerEntries', `${n(ledger.entries.length)}${hdr.ledgerTruncated ? '  (TRUNCATED — counts exact, positions capped)' : ''}  source: ${ledger.source}`],
    ['sidecar', sidecarMatches === null ? '(absent)' : `${sidecarPath}  recordingId ${sidecarMatches ? 'matches' : 'DOES NOT MATCH — embedded header wins'}`],
  ];
  process.stdout.write(`${rows.map(([k, v]) => (k ? `  ${k.padEnd(22)} ${v}` : '')).join('\n')}\n`);

  for (const e of ledger.entries.slice(0, 20)) {
    process.stdout.write(`    frame ${n(e.startFrameIndex).padStart(14)}  +${n(e.frameCount).padStart(10)} frames   t=${(e.startFrameIndex / hdr.sampleRateExactHz).toFixed(3)}s   ${e.cause}\n`);
  }
  return 0;
}
