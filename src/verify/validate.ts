// The validator's core (PLAN §10): do the bytes on disk equal value(c, n) for every (c, n) the file
// claims, and is the set of n exactly [0, totalFrames)?
//
// Streaming, O(1) memory: one reused block buffer and a handful of counters. The expected signal is
// recomputed one value at a time from the closed-form function — never materialised.

import fs from 'node:fs';
import { createSignal, SIGNAL_ID } from '../signal/signal.ts';
import * as blockHeader from '../format/block-header.ts';
import { crc32c } from '../format/crc32c.ts';
import { blockOffset, readLedger } from '../store/recover.ts';
import type { Recording } from '../store/recover.ts';
import { UnreadableError } from '../format/file-header.ts';

export const EXIT = { PASS: 0, FAIL: 1, TRUNCATED: 2, UNREADABLE: 3, USAGE: 64 } as const;

type Class = 'missing' | 'duplicated' | 'incorrect' | 'corrupt';
export type Discrepancy = Record<string, number | string | undefined>;

export interface ValidationResult {
  file: string;
  result: 'PASS' | 'PASS (TRUNCATED)' | 'FAIL';
  exitCode: number;
  expectedValues: number;
  recordedValues: number;
  missing: number;
  duplicated: number;
  incorrect: number;
  corrupt: number;
  finalised: boolean;
  recovered: boolean;
  truncated: boolean;
  blockCount: number;
  firstDiscrepancy: Record<Class, Discrepancy | null>;
  declaredDroppedValues: number | null;
  ledgerAgreesWithDerivedGaps: boolean | null;
  crcChecked: boolean;
  elapsedSeconds: number;
  throughputValuesPerSecond: number;
  peakRssBytes: number;
}

export function validate(rec: Recording, { checkCrc = true }: { checkCrc?: boolean } = {}): ValidationResult {
  const { fd, hdr, extent } = rec;
  // Refuse a formula we cannot reproduce: validating it anyway would report every value incorrect.
  if (hdr.signalId !== SIGNAL_ID) throw new UnreadableError(`file declares signalId ${JSON.stringify(hdr.signalId)}; this validator knows ${JSON.stringify(SIGNAL_ID)}`);
  if (hdr.dtypeCode !== 1) throw new UnreadableError(`dtypeCode ${hdr.dtypeCode} is not float32LE`);

  const C = hdr.channelCount;
  const signal = createSignal({ channelCount: C, dither: !hdr.ditherDisabled });
  const block = Buffer.allocUnsafeSlow(hdr.blockStrideBytes);
  const payloadValues = (hdr.blockStrideBytes - hdr.blockHeaderBytes) / 4;
  const payloadU32 = new Uint32Array(block.buffer, block.byteOffset + hdr.blockHeaderBytes, payloadValues);
  const payloadF32 = new Float32Array(block.buffer, block.byteOffset + hdr.blockHeaderBytes, payloadValues);
  // Compare bit patterns, not ===: NaN !== NaN would under-report, -0 === +0 would over-accept.
  const expected = new Float32Array(1);
  const expectedU32 = new Uint32Array(expected.buffer);

  const count = { missing: 0, duplicated: 0, incorrect: 0, corrupt: 0 };
  const first: Record<Class, Discrepancy | null> = { missing: null, duplicated: null, incorrect: null, corrupt: null };
  const note = (cls: Class, d: Discrepancy) => (first[cls] ??= d);
  const at = (frameIndex: number, extra: Discrepancy = {}): Discrepancy => ({ valueIndex: frameIndex * C, frameIndex, timeSeconds: frameIndex / hdr.sampleRateExactHz, ...extra });
  let recorded = 0;
  let expectedNext = 0;
  let truncatedEarly = false;
  const t0 = process.hrtime.bigint();

  for (let b = 0; b < extent.blockCount; b++) {
    const off = blockOffset(hdr, b);
    const got = fs.readSync(fd, block, 0, hdr.blockStrideBytes, off);
    const bh = got >= hdr.blockHeaderBytes ? blockHeader.decode(block, 0) : null;
    if (!bh || !bh.headerCrcOk) {
      if (!bh) { truncatedEarly = true; break; }
      count.corrupt += hdr.framesPerBlock * C; // an unreadable header: its nominal span is corrupt
      note('corrupt', { blockIndex: b, byteOffset: off });
      expectedNext += hdr.framesPerBlock;
      continue;
    }
    if (got < hdr.blockHeaderBytes + bh.payloadBytes) { truncatedEarly = true; break; }

    // Sequence: the same three-line rule the recorder uses.
    if (bh.startFrameIndex > expectedNext) {
      const gap = bh.startFrameIndex - expectedNext;
      count.missing += gap * C;
      note('missing', at(expectedNext, { valueCount: gap * C, blockIndex: b }));
      expectedNext = bh.startFrameIndex;
    } else if (bh.startFrameIndex < expectedNext) {
      const overlap = Math.min(expectedNext - bh.startFrameIndex, bh.frameCount);
      count.duplicated += overlap * C;
      note('duplicated', at(bh.startFrameIndex, { valueCount: overlap * C, blockIndex: b }));
    }
    recorded += bh.frameCount * C;
    expectedNext = Math.max(expectedNext, bh.startFrameIndex + bh.frameCount);

    // A failed CRC is its own class: otherwise bit-rot reads as 128,000 "incorrect values".
    if (checkCrc && crc32c(block, hdr.blockHeaderBytes, hdr.blockHeaderBytes + bh.payloadBytes) !== bh.payloadCrc32c) {
      count.corrupt += bh.frameCount * C;
      note('corrupt', { blockIndex: b, byteOffset: off, frameIndex: bh.startFrameIndex });
      continue;
    }
    for (let c = 0; c < C; c++) {
      const base = c * bh.frameCount;
      for (let j = 0; j < bh.frameCount; j++) {
        expected[0] = signal.value(c, bh.startFrameIndex + j);
        if (expectedU32[0] === payloadU32[base + j]) continue;
        count.incorrect++;
        if (!first.incorrect) {
          const frameIndex = bh.startFrameIndex + j;
          first.incorrect = { ...at(frameIndex), valueIndex: frameIndex * C + c, channel: c, expected: expected[0], actual: payloadF32[base + j], blockIndex: b, byteOffset: off + hdr.blockHeaderBytes + (base + j) * 4 };
        }
      }
    }
  }

  const elapsedSeconds = Number(process.hrtime.bigint() - t0) / 1e9;
  const trusted = hdr.finalised && !extent.recovered;

  // F-04: the verdict also answers to what the file declares. Loss ledgered at or past the last
  // recorded frame leaves no gap to derive, but it is known, positioned loss, so it counts as missing.
  // Then the two independent accounts must agree: a recording that contradicts itself never passes.
  if (trusted) {
    for (const e of readLedger(rec).entries) {
      if (e.startFrameIndex < expectedNext) continue;
      count.missing += e.frameCount * C;
      note('missing', at(e.startFrameIndex, { valueCount: e.frameCount * C, cause: e.cause }));
    }
  }
  const declaredDroppedValues = trusted ? hdr.droppedFramesTotal * C : null;
  const ledgerAgreesWithDerivedGaps = declaredDroppedValues === null ? null : declaredDroppedValues === count.missing;

  const failed = count.missing > 0 || count.duplicated > 0 || count.incorrect > 0 || count.corrupt > 0 || ledgerAgreesWithDerivedGaps === false;
  const truncated = !trusted || truncatedEarly;
  return {
    file: rec.filePath,
    result: failed ? 'FAIL' : truncated ? 'PASS (TRUNCATED)' : 'PASS',
    exitCode: failed ? EXIT.FAIL : truncated ? EXIT.TRUNCATED : EXIT.PASS,
    expectedValues: trusted ? hdr.totalValues : extent.totalValues,
    recordedValues: recorded,
    ...count,
    finalised: hdr.finalised,
    recovered: extent.recovered,
    truncated,
    blockCount: extent.blockCount,
    firstDiscrepancy: first,
    declaredDroppedValues,
    ledgerAgreesWithDerivedGaps,
    crcChecked: checkCrc,
    elapsedSeconds: +elapsedSeconds.toFixed(3),
    throughputValuesPerSecond: Math.round(recorded / Math.max(elapsedSeconds, 1e-9)),
    peakRssBytes: process.memoryUsage.rss(),
  };
}
