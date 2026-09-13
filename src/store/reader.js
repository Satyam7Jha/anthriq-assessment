'use strict';
// Streaming reader: O(1) seek, channel-subset reads, bounded memory. PLAN §9.1–9.3.
//
// MEMORY CONTRACT (R37): resident bytes = blockHeaderBytes + k * framesPerBlock * bytesPerValue.
// For k=2 that is 32 KB; for all 32 channels, 512 KB. INDEPENDENT of file size — reading a 41 GiB
// 24-hour recording uses the same 512 KB as reading a 10-second one. The file is never materialised
// and no more than one block's worth of any channel is held at a time.
//
// Every fs.read goes through readCounted() so the byte count is MEASURED, not asserted. bench/seek
// compares it against the closed-form prediction in §9.2 and fails if they disagree — which is what
// turns "reads only the required data" from a claim into a check.

const fs = require('node:fs');
const blockHeaderMod = require('../format/block-header');
const { blockOffset, readBlockHeaderSync } = require('./recover');

class ReadStats {
  constructor() {
    this.bytesRead = 0;
    this.readCalls = 0;
    this.blockHeaderReads = 0;
    this.channelRunReads = 0;
  }
}

function makeReader(fd, hdr, extent) {
  const stats = new ReadStats();
  const bytesPerValue = hdr.bytesPerValue;
  const framesPerBlock = hdr.framesPerBlock;
  const channelRunBytes = framesPerBlock * bytesPerValue;

  function readCounted(buf, offset, length, position, kind) {
    const got = fs.readSync(fd, buf, offset, length, position);
    stats.bytesRead += got;
    stats.readCalls++;
    if (kind === 'header') stats.blockHeaderReads++;
    else if (kind === 'run') stats.channelRunReads++;
    return got;
  }

  const hdrBuf = Buffer.allocUnsafe(hdr.blockHeaderBytes);

  function blockHeaderAt(blockIndex) {
    if (blockIndex < 0 || blockIndex >= extent.blockCount) return null;
    const got = readCounted(hdrBuf, 0, hdr.blockHeaderBytes, blockOffset(hdr, blockIndex), 'header');
    if (got < hdr.blockHeaderBytes) return null;
    const bh = blockHeaderMod.decode(hdrBuf, 0);
    return bh.magicOk && bh.headerCrcOk ? bh : null;
  }

  /**
   * Locate the block containing `frameIndex`. PLAN §9.1.
   *
   * The O(1) guess assumes startFrameIndex == blockIndex * framesPerBlock, which holds IFF the run
   * had no drops. When it does not, fall back to a binary search over block headers: block headers
   * are monotonically ordered in startFrameIndex, so this is valid, and it costs log2(N) 64-byte
   * reads — 12 reads (768 B) for a one-hour file, 17 for a 24-hour one. The drop-free case never
   * pays for it, because the guess is checked before the search begins.
   */
  function findBlock(frameIndex) {
    const guess = Math.floor(frameIndex / framesPerBlock);
    const bh = blockHeaderAt(guess);
    if (bh && frameIndex >= bh.startFrameIndex && frameIndex < bh.startFrameIndex + bh.frameCount) {
      return { blockIndex: guess, bh, method: 'closed-form', probes: 1 };
    }
    let lo = 0;
    let hi = extent.blockCount - 1;
    let probes = bh ? 1 : 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const m = blockHeaderAt(mid);
      probes++;
      if (!m) {
        hi = mid - 1;
        continue;
      }
      if (frameIndex < m.startFrameIndex) hi = mid - 1;
      else if (frameIndex >= m.startFrameIndex + m.frameCount) lo = mid + 1;
      else return { blockIndex: mid, bh: m, method: 'binary-search', probes };
    }
    // The frame falls inside a gap: no block contains it. Return the first block AFTER the gap, so a
    // range that starts in lost data still reads everything that does exist in it. Returning null
    // here made a review window opened inside a gap render nothing at all.
    if (lo < extent.blockCount) {
      const next = blockHeaderAt(lo);
      probes++;
      if (next && next.startFrameIndex > frameIndex) return { blockIndex: lo, bh: next, method: 'after-gap', probes };
    }
    return null;
  }

  /**
   * Stream a time range for a channel subset. Yields one object per block per channel, reusing a
   * single Buffer per channel — the consumer must copy if it needs to retain the data, which is the
   * explicit price of not growing memory with the window.
   */
  function* readRange({ fromFrame, toFrame, channels }) {
    const chans = channels ?? Array.from({ length: hdr.channelCount }, (_, i) => i);
    for (const c of chans) {
      if (!Number.isInteger(c) || c < 0 || c >= hdr.channelCount) {
        throw new RangeError(`channel ${c} out of range 0..${hdr.channelCount - 1}`);
      }
    }
    // One reusable run buffer per requested channel. This IS the memory bound.
    const runBufs = chans.map(() => Buffer.allocUnsafeSlow(channelRunBytes));

    const start = findBlock(fromFrame);
    if (!start) return;
    // Reuse the header findBlock already read, and stop WITHOUT reading the next block's header once
    // the range is covered. Both matter: they are what make the measured byte count equal the
    // closed-form prediction exactly, rather than "the prediction plus two stray reads".
    let carried = start.bh;
    for (let b = start.blockIndex; b < extent.blockCount; b++) {
      const bh = carried ?? blockHeaderAt(b);
      carried = null;
      if (!bh) break;
      if (bh.startFrameIndex >= toFrame) break;
      const blockStart = Math.max(fromFrame, bh.startFrameIndex);
      const blockEnd = Math.min(toFrame, bh.startFrameIndex + bh.frameCount);
      if (blockEnd <= blockStart) continue;
      const firstInBlock = blockStart - bh.startFrameIndex;
      const count = blockEnd - blockStart;
      const payloadBase = blockOffset(hdr, b) + hdr.blockHeaderBytes;

      for (let i = 0; i < chans.length; i++) {
        const c = chans[i];
        // Planar within the block: channel c's run starts at c * frameCount values. Only the
        // requested slice of the requested channel is read — k of C channels costs k/C of the bytes.
        const runOffset = payloadBase + (c * bh.frameCount + firstInBlock) * bytesPerValue;
        const bytes = count * bytesPerValue;
        readCounted(runBufs[i], 0, bytes, runOffset, 'run');
        yield {
          channel: c,
          blockIndex: b,
          startFrameIndex: blockStart,
          frameCount: count,
          data: new Float32Array(runBufs[i].buffer, runBufs[i].byteOffset, count),
          precedingGapFrames: firstInBlock === 0 ? bh.precedingGapFrames : 0,
        };
      }
      if (bh.startFrameIndex + bh.frameCount >= toFrame) break;
    }
  }

  /** Read one contiguous run of ONE channel into a caller-supplied Float32Array. Used by the UI. */
  function readChannelRun(channel, fromFrame, count, out) {
    let written = 0;
    for (const chunk of readRange({ fromFrame, toFrame: fromFrame + count, channels: [channel] })) {
      const take = Math.min(chunk.frameCount, out.length - written);
      out.set(chunk.data.subarray(0, take), written);
      written += take;
      if (written >= out.length) break;
    }
    return written;
  }

  /** The closed-form prediction of §9.2, so callers can assert measured == predicted. */
  function predictBytes({ fromFrame, toFrame, channelCount: k }) {
    const firstBlock = Math.floor(fromFrame / framesPerBlock);
    const lastBlock = Math.floor((toFrame - 1) / framesPerBlock);
    const blocks = lastBlock - firstBlock + 1;
    return {
      blocks,
      headerBytes: blocks * hdr.blockHeaderBytes,
      // The final block of a range is usually partial, so the honest prediction counts frames, not
      // whole channel runs.
      payloadBytes: k * (toFrame - fromFrame) * bytesPerValue,
      get totalBytes() {
        return this.headerBytes + this.payloadBytes;
      },
      readCalls: blocks * (1 + k),
    };
  }

  return { stats, findBlock, readRange, readChannelRun, blockHeaderAt, predictBytes, channelRunBytes };
}

module.exports = { makeReader };
