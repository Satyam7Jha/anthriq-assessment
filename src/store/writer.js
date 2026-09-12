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

    // Double-buffered assembly: one buffer can be in flight on the threadpool while the next block
    // is transposed into the other. Two buffers, allocated once — not one per block.
    this.bufs = [
      Buffer.allocUnsafeSlow(cfg.blockStrideBytes),
      Buffer.allocUnsafeSlow(cfg.blockStrideBytes),
    ];
    this.next = 0;
    this.inFlight = false;
    this.pending = []; // assembled blocks awaiting their turn; bounded by the ring's capacity

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

  /**
   * Assemble one file block from interleaved frame bytes and queue it for writing.
   * @param {Buffer} interleaved source holding frameCount*channelCount float32s
   * @param {number} srcOffset byte offset into `interleaved`
   */
  enqueue({ interleaved, srcOffset, startFrameIndex, frameCount, precedingGapFrames, monotonicNanos }) {
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
    this.filePosition += job.bytes;

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
      this.onWritten(job, ms);
      this.#kick();
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
