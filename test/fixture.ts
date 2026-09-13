// A small, valid recording written straight from the format codecs, so reader-side tests need no
// processes: C channels at RATE Hz, BLOCKS one-second blocks of the deterministic signal, not finalised.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as fileHeader from '../src/format/file-header.ts';
import * as blockHeader from '../src/format/block-header.ts';
import { crc32c } from '../src/format/crc32c.ts';
import { createSignal } from '../src/signal/signal.ts';

export const C = 4;
export const RATE = 1000;
export const FRAMES_PER_BLOCK = 1000;
export const BLOCKS = 2;
export const TOTAL = FRAMES_PER_BLOCK * BLOCKS;

export function writeFixture(): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sigacq-fixture-')), 'fixture.sigb');
  const stride = 64 + FRAMES_PER_BLOCK * C * 4;
  const header = fileHeader.encode({
    recordingId: Buffer.alloc(16, 1),
    channelCount: C,
    sampleRateHz: RATE,
    framesPerBlock: FRAMES_PER_BLOCK,
    blockStrideBytes: stride,
    totalFrames: TOTAL,
    totalValues: TOTAL * C,
    startTimestampUnixNanos: 0n,
    signalId: 'tri+saw+hash32/v1',
    flags: 0,
  });
  const signal = createSignal({ channelCount: C });
  const blocks = Buffer.alloc(stride * BLOCKS);
  for (let b = 0; b < BLOCKS; b++) {
    const off = b * stride;
    const payload = new Float32Array(blocks.buffer, blocks.byteOffset + off + 64, FRAMES_PER_BLOCK * C);
    signal.fillPlanar(payload, 0, b * FRAMES_PER_BLOCK, FRAMES_PER_BLOCK);
    const payloadBytes = FRAMES_PER_BLOCK * C * 4;
    blockHeader.encode(blocks, off, { startFrameIndex: b * FRAMES_PER_BLOCK, frameCount: FRAMES_PER_BLOCK, payloadBytes, blockIndex: b, monotonicNanos: 0n, flags: 0, precedingGapFrames: 0, payloadCrc32c: crc32c(blocks, off + 64, off + 64 + payloadBytes) });
  }
  fs.writeFileSync(file, Buffer.concat([header, blocks]));
  return file;
}
