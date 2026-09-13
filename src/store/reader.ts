// Streaming reader: O(1) seek, channel-subset reads, bounded memory.
//
// Resident memory is blockHeaderBytes + k * framesPerBlock * bytesPerValue — 32 KB for two channels,
// 512 KB for 32 — independent of file size. Every read is counted, so "reads only what it needs" is
// checked against the closed-form prediction rather than asserted.

import fs from 'node:fs';
import type { BlockHeader } from '../format/block-header.ts';
import { blockOffset, readBlockHeader } from './recover.ts';
import type { Recording } from './recover.ts';

export interface Chunk {
  channel: number;
  blockIndex: number;
  startFrameIndex: number;
  frameCount: number;
  /** A view over a buffer the reader reuses — copy it to keep it. */
  data: Float32Array;
}

export interface BlockHit {
  blockIndex: number;
  bh: BlockHeader;
  method: 'closed-form' | 'binary-search' | 'after-gap';
  probes: number;
}

export function makeReader({ fd, hdr, extent }: Pick<Recording, 'fd' | 'hdr' | 'extent'>) {
  const stats = { bytesRead: 0, readCalls: 0 };
  const hdrBuf = Buffer.allocUnsafe(hdr.blockHeaderBytes);
  // One block-sized run buffer per channel slot, kept across calls: playback reads 200 small ranges a
  // second, and allocating per call would turn the memory bound into garbage-collector pressure.
  const runBufs: Buffer[] = [];
  const runBytes = hdr.framesPerBlock * hdr.bytesPerValue;

  function headerAt(b: number): BlockHeader | null {
    if (b < 0 || b >= extent.blockCount) return null;
    stats.bytesRead += hdr.blockHeaderBytes;
    stats.readCalls++;
    return readBlockHeader(fd, hdr, b, hdrBuf);
  }

  /**
   * The block containing `frameIndex`. The closed-form guess holds when nothing was dropped; after a
   * drop, binary-search the monotonic block headers (log2 N reads — 12 for an hour). A frame inside a
   * gap resolves to the first block after it, so a range starting in lost data still reads what exists.
   */
  function findBlock(frameIndex: number): BlockHit | null {
    const guess = Math.floor(frameIndex / hdr.framesPerBlock);
    const g = headerAt(guess);
    if (g && frameIndex >= g.startFrameIndex && frameIndex < g.startFrameIndex + g.frameCount) {
      return { blockIndex: guess, bh: g, method: 'closed-form', probes: 1 };
    }
    let [lo, hi, probes] = [0, extent.blockCount - 1, g ? 1 : 0];
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const m = headerAt(mid);
      probes++;
      if (!m || frameIndex < m.startFrameIndex) hi = mid - 1;
      else if (frameIndex >= m.startFrameIndex + m.frameCount) lo = mid + 1;
      else return { blockIndex: mid, bh: m, method: 'binary-search', probes };
    }
    const next = headerAt(lo);
    return next && next.startFrameIndex > frameIndex ? { blockIndex: lo, bh: next, method: 'after-gap', probes: probes + 1 } : null;
  }

  /**
   * Stream [fromFrame, toFrame) for a channel subset: one chunk per block per channel. Finish one range
   * before starting another on the same reader — the run buffers are shared between calls.
   */
  function* readRange({ fromFrame, toFrame, channels }: { fromFrame: number; toFrame: number; channels: number[] }): Generator<Chunk> {
    for (const c of channels) {
      if (!Number.isInteger(c) || c < 0 || c >= hdr.channelCount) throw new RangeError(`channel ${c} out of range 0..${hdr.channelCount - 1}`);
    }
    while (runBufs.length < channels.length) runBufs.push(Buffer.allocUnsafeSlow(runBytes)); // the memory bound
    const start = findBlock(fromFrame);
    if (!start) return;
    // Reuse the header findBlock read, and stop before reading past the range: that is what makes the
    // measured byte count equal the prediction exactly.
    let carried: BlockHeader | null = start.bh;
    for (let b = start.blockIndex; b < extent.blockCount; b++) {
      const bh = carried ?? headerAt(b);
      carried = null;
      if (!bh || bh.startFrameIndex >= toFrame) break;
      const from = Math.max(fromFrame, bh.startFrameIndex);
      const to = Math.min(toFrame, bh.startFrameIndex + bh.frameCount);
      if (to > from) {
        const payload = blockOffset(hdr, b) + hdr.blockHeaderBytes;
        for (let i = 0; i < channels.length; i++) {
          // Planar: channel c's run starts at c * frameCount values into the payload.
          const offset = payload + (channels[i] * bh.frameCount + (from - bh.startFrameIndex)) * hdr.bytesPerValue;
          const count = to - from;
          fs.readSync(fd, runBufs[i], 0, count * hdr.bytesPerValue, offset);
          stats.bytesRead += count * hdr.bytesPerValue;
          stats.readCalls++;
          yield { channel: channels[i], blockIndex: b, startFrameIndex: from, frameCount: count, data: new Float32Array(runBufs[i].buffer, runBufs[i].byteOffset, count) };
        }
      }
      if (bh.startFrameIndex + bh.frameCount >= toFrame) break;
    }
  }

  /** The closed-form cost of a read: blocks * headerBytes + k * frames * bytesPerValue. */
  function predictBytes({ fromFrame, toFrame, channelCount: k }: { fromFrame: number; toFrame: number; channelCount: number }): number {
    const blocks = Math.floor((toFrame - 1) / hdr.framesPerBlock) - Math.floor(fromFrame / hdr.framesPerBlock) + 1;
    return blocks * hdr.blockHeaderBytes + k * (toFrame - fromFrame) * hdr.bytesPerValue;
  }

  return { stats, findBlock, readRange, predictBytes };
}

export type Reader = ReturnType<typeof makeReader>;
