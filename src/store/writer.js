'use strict';
// Block assembly, transpose, and the one-write-in-flight disk path. PLAN §7.3.
//
// THE central decision here: AT MOST ONE fs.write IN FLIGHT. It makes the ring the ONLY queue in the
// system. If writes were issued freely, libuv's threadpool queue would become a second, unbounded,
// INVISIBLE buffer — exactly the "queue growth proportional to elapsed time" the assessment
// forbids, and it would be invisible to the watermark logic too. One-in-flight means ring fill is a
// true and complete measure of backlog. The cost is lost pipelining: one 512 KB write per second
// against an SSD that does >1 GB/s, which is nothing.
//
// Async fs.write, not writeSync: writeSync blocks the event loop for the duration of the write,
// which also blocks the socket reads filling the ring, converting a disk stall directly into a
// socket stall and then into generator drops. Async writes run on the threadpool, leaving the loop
// free to keep draining the socket. That is the whole reason the ring exists.

const fs = require('node:fs');
const blockHeader = require('../format/block-header');
const { crc32c } = require('../format/crc32c');

class BlockWriter {
  constructor({ fd, cfg, onWritten = () => {}, onError = () => {} }) {
    this.fd = fd;
    this.cfg = cfg;
    this.onWritten = onWritten;
    this.onError = onError;

    // Double-buffered assembly: one buffer can be in flight on the libuv threadpool while the next
    // block is transposed into the other. Two buffers, allocated once — never one per block.
    //
    // The invariant that makes two buffers SUFFICIENT and SAFE: at most one write is in flight and
    // at most one assembled block waits behind it. fs.write, like socket.write, does not copy the
    // buffer it is given, so a third assembled block would recycle a buffer the kernel is still
    // reading from — a silent corruption bug.
    //
    // It is also why `pending` holds at most one entry. An unbounded pending array would be a SECOND
    // queue, and the whole point of one-write-in-flight (PLAN §7.3) is that the ring is the ONLY
    // queue: if backlog could accumulate here as well, ring fill would stop being a true measure of
    // it and the watermark logic would be blind. Backlog belongs in the ring, where it is bounded,
    // measured, and visible.
    this.bufs = [
      Buffer.allocUnsafeSlow(cfg.blockStrideBytes),
      Buffer.allocUnsafeSlow(cfg.blockStrideBytes),
    ];
    this.next = 0;
    this.inFlight = false;
    this.pending = []; // at most ONE entry, by the invariant above
    this.maxPending = 1;

    this.blocksWritten = 0;
    this.bytesWritten = 0;
    this.filePosition = require('../config/defaults').FILE_HEADER_BYTES;
    this.totalFrames = 0; // advanced ONLY after the kernel has accepted the write
    this.lastFrameEnd = 0;
    this.writeLatencyMaxMs = 0;
    this.writeLatencySumMs = 0;
    this.fsyncCount = 0;
    this.fsyncMaxMs = 0;
    this.errored = null;
  }

  get queuedBlocks() {
    return this.pending.length + (this.inFlight ? 1 : 0);
  }

  /** True when enqueue() is safe. The caller must check this and leave the frames in the ring
   *  otherwise — that is what keeps the ring the only queue. */
  get canAccept() {
    return !this.errored && this.pending.length < this.maxPending;
  }

  /**
   * Assemble one file block from interleaved frame bytes and queue it for writing.
   * @param {Buffer} interleaved source holding frameCount*channelCount float32s
   * @param {number} srcOffset byte offset into `interleaved`
   */
  enqueue({ interleaved, srcOffset, startFrameIndex, frameCount, precedingGapFrames, monotonicNanos }) {
    if (!this.canAccept) {
      // Programming error, not a runtime condition: callers gate on canAccept. Failing loudly beats
      // recycling a buffer the kernel is still reading.
      throw new Error(`BlockWriter.enqueue called while ${this.pending.length} block(s) already pending`);
    }
    const { channelCount, framesPerBlock, bytesPerValue } = this.cfg;
    const buf = this.bufs[this.next];
    this.next = (this.next + 1) % this.bufs.length;
    const payloadBytes = frameCount * channelCount * bytesPerValue;

    // TRANSPOSE interleaved -> planar (PLAN §8.4). The wire's consumer wants whole frames; the
    // file's consumer wants channel-contiguous runs, so a k-of-C channel subset costs k/C of the
    // bytes. The recorder performs the single transpose, once, in the one place that has both a
    // complete block and spare time.
    const src = new Float32Array(interleaved.buffer, interleaved.byteOffset + srcOffset, frameCount * channelCount);
    const dst = new Float32Array(buf.buffer, buf.byteOffset + blockHeader.HEADER_BYTES, frameCount * channelCount);
    for (let c = 0; c < channelCount; c++) {
      let w = c * frameCount;
      for (let j = 0, r = c; j < frameCount; j++, r += channelCount) dst[w++] = src[r];
    }

    const payloadCrc32c = crc32c(buf, blockHeader.HEADER_BYTES, blockHeader.HEADER_BYTES + payloadBytes);
    blockHeader.encode(buf, 0, {
      startFrameIndex,
      frameCount,
      payloadBytes,
      blockIndex: this.blocksWritten + this.pending.length + (this.inFlight ? 1 : 0),
      monotonicNanos,
      flags:
        (frameCount < framesPerBlock ? blockHeader.FLAG.SHORT_BLOCK : 0) |
        (precedingGapFrames > 0 ? blockHeader.FLAG.PRECEDED_BY_GAP : 0),
      precedingGapFrames,
      payloadCrc32c,
    });

    this.pending.push({ buf, bytes: blockHeader.HEADER_BYTES + payloadBytes, startFrameIndex, frameCount });
    this.#kick();
  }

  #kick() {
    if (this.inFlight || this.pending.length === 0 || this.errored) return;
    const job = this.pending.shift();
    this.inFlight = true;
    const t0 = process.hrtime.bigint();
    const position = this.filePosition;
    // EVERY block occupies exactly blockStrideBytes on disk, even a SHORT one. This is the invariant
    // the whole format rests on: blockStrideBytes is "the single number an O(1) seek needs"
    // (PLAN §8.2), and a mid-file block that occupied fewer bytes would silently invalidate every
    // offset formula after it — seek, channel-subset reads, and the truncation-recovery block count.
    // A short block therefore writes only its valid bytes and leaves the remainder of its stride as a
    // sparse hole; the block header's own frameCount bounds the valid payload, so a reader never
    // looks at the hole. Short blocks occur only at a gap boundary or at shutdown, so the wasted
    // bytes are bounded by (number of gaps + 1) * blockStrideBytes.
    this.filePosition += this.cfg.blockStrideBytes;

    fs.write(this.fd, job.buf, 0, job.bytes, position, (err, written) => {
      this.inFlight = false;
      if (err) {
        // ENOSPC, EIO. The prefix already written stays valid and readable — every block is
        // independently self-describing — so the correct behaviour is to report and stop cleanly,
        // not to crash mid-block.
        this.errored = err;
        this.onError(err, job);
        return;
      }
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (ms > this.writeLatencyMaxMs) this.writeLatencyMaxMs = ms;
      this.writeLatencySumMs += ms;
      this.blocksWritten++;
      this.bytesWritten += written;
      // The header's totalFrames is advanced ONLY here — after the kernel has accepted the write —
      // so the header never claims data the kernel has not got.
      this.lastFrameEnd = job.startFrameIndex + job.frameCount;
      this.totalFrames += job.frameCount;
      this.#kick();
      // Notified AFTER #kick so the callback can assemble the next block into the buffer this write
      // just released.
      this.onWritten(job, ms);
    });
  }

  /** Resolve once every queued and in-flight write has completed. */
  async drain() {
    while ((this.inFlight || this.pending.length > 0) && !this.errored) {
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  async fsync() {
    const t0 = process.hrtime.bigint();
    await new Promise((resolve) => fs.fsync(this.fd, () => resolve()));
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    this.fsyncCount++;
    if (ms > this.fsyncMaxMs) this.fsyncMaxMs = ms;
    return ms;
  }
}

module.exports = { BlockWriter };
