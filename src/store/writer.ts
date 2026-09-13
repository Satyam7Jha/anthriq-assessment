// Block assembly, transpose, and the one-write-in-flight disk path (PLAN §7.3).
//
// AT MOST ONE fs.write IN FLIGHT, so the ring is the only queue. Free-running writes would turn
// libuv's threadpool into a second, unbounded, invisible buffer the watermarks cannot see.
// Async, not writeSync: a blocking write would also stop socket reads, turning a disk stall into a
// socket stall and then into generator drops.

import fs from 'node:fs';
import * as blockHeader from '../format/block-header.ts';
import { crc32c } from '../format/crc32c.ts';
import { DEFAULTS as D } from '../config/defaults.ts';

export interface WriterGeometry {
  channelCount: number;
  framesPerBlock: number;
  bytesPerValue: number;
  blockStrideBytes: number;
}

interface Job {
  buf: Buffer;
  bytes: number;
  startFrameIndex: number;
  frameCount: number;
}

export interface WriterOptions {
  fd: number;
  geometry: WriterGeometry;
  onWritten?: () => void;
  onError?: (err: NodeJS.ErrnoException) => void;
  /** Fault injection (F7): hold each write back by this many ms — indistinguishable from a slow disk. */
  injectStallMs?: number;
}

export class BlockWriter {
  readonly injectStallMs: number;
  #o: WriterOptions;
  #g: WriterGeometry;
  // Two assembly buffers, allocated once. fs.write does not copy, so at most one write in flight plus
  // one assembled block waiting is exactly what two buffers can serve without recycling a live one.
  #bufs: [Buffer, Buffer];
  #next = 0;
  #pending: Job[] = []; // at most one entry — backlog belongs in the ring, where it is measured
  #inFlight: Job | null = null;
  #closed = false;
  errored: NodeJS.ErrnoException | null = null;
  filePosition: number = D.FILE_HEADER_BYTES;
  blocksWritten = 0;
  bytesWritten = 0;
  totalFrames = 0; // advanced only after the kernel accepted the write
  writeLatencyMaxMs = 0;
  fsyncCount = 0;
  fsyncMaxMs = 0;

  constructor(o: WriterOptions) {
    this.#o = o;
    this.#g = o.geometry;
    this.injectStallMs = o.injectStallMs ?? 0;
    this.#bufs = [Buffer.allocUnsafeSlow(this.#g.blockStrideBytes), Buffer.allocUnsafeSlow(this.#g.blockStrideBytes)];
  }

  get queuedBlocks(): number {
    return this.#pending.length + (this.#inFlight ? 1 : 0);
  }

  /** Callers must check this and otherwise leave frames in the ring. */
  get canAccept(): boolean {
    return !this.errored && !this.#closed && this.#pending.length === 0;
  }

  /** Stop issuing writes, so nothing is written over the trailer that shutdown places at filePosition. */
  close(): void {
    this.#closed = true;
  }

  /** Frames handed over but not yet acknowledged, as positioned ranges. */
  unacknowledged(): { startFrameIndex: number; frameCount: number }[] {
    return [...(this.#inFlight ? [this.#inFlight] : []), ...this.#pending].map(({ startFrameIndex, frameCount }) => ({ startFrameIndex, frameCount }));
  }

  enqueue(b: { interleaved: Buffer; srcOffset: number; startFrameIndex: number; frameCount: number; precedingGapFrames: number; monotonicNanos: bigint }): void {
    if (!this.canAccept) throw new Error('BlockWriter.enqueue called while a block is already pending');
    const { channelCount, framesPerBlock, bytesPerValue } = this.#g;
    const buf = this.#bufs[this.#next];
    this.#next ^= 1;
    const values = b.frameCount * channelCount;
    const payloadBytes = values * bytesPerValue;

    // Transpose interleaved -> planar, once, so a k-of-C channel read costs k/C of the bytes.
    const src = new Float32Array(b.interleaved.buffer, b.interleaved.byteOffset + b.srcOffset, values);
    const dst = new Float32Array(buf.buffer, buf.byteOffset + blockHeader.HEADER_BYTES, values);
    for (let c = 0; c < channelCount; c++) {
      let w = c * b.frameCount;
      for (let j = 0, r = c; j < b.frameCount; j++, r += channelCount) dst[w++] = src[r];
    }

    blockHeader.encode(buf, 0, {
      startFrameIndex: b.startFrameIndex,
      frameCount: b.frameCount,
      payloadBytes,
      blockIndex: this.blocksWritten + this.queuedBlocks,
      monotonicNanos: b.monotonicNanos,
      flags: (b.frameCount < framesPerBlock ? blockHeader.FLAG.SHORT_BLOCK : 0) | (b.precedingGapFrames > 0 ? blockHeader.FLAG.PRECEDED_BY_GAP : 0),
      precedingGapFrames: b.precedingGapFrames,
      payloadCrc32c: crc32c(buf, blockHeader.HEADER_BYTES, blockHeader.HEADER_BYTES + payloadBytes),
    });
    this.#pending.push({ buf, bytes: blockHeader.HEADER_BYTES + payloadBytes, startFrameIndex: b.startFrameIndex, frameCount: b.frameCount });
    this.#kick();
  }

  #kick(): void {
    if (this.#inFlight || this.#pending.length === 0 || this.errored || this.#closed) return;
    const job = this.#pending.shift()!;
    this.#inFlight = job;
    const position = this.filePosition;
    // Every block occupies a full stride, even a short one: blockStrideBytes is what makes seek
    // closed-form. The unused tail is a sparse hole; the block's own frameCount bounds what is read.
    this.filePosition += this.#g.blockStrideBytes;
    const t0 = process.hrtime.bigint();
    const write = () => fs.write(this.#o.fd, job.buf, 0, job.bytes, position, (err, written) => this.#done(job, t0, err, written));
    if (this.injectStallMs > 0) setTimeout(write, this.injectStallMs);
    else write();
  }

  #done(job: Job, t0: bigint, err: NodeJS.ErrnoException | null, written: number): void {
    this.#inFlight = null;
    if (err) {
      // ENOSPC, EIO: every committed block is self-describing, so stop cleanly rather than crash.
      this.errored = err;
      this.#o.onError?.(err);
      return;
    }
    this.writeLatencyMaxMs = Math.max(this.writeLatencyMaxMs, Number(process.hrtime.bigint() - t0) / 1e6);
    this.blocksWritten++;
    this.bytesWritten += written;
    this.totalFrames += job.frameCount;
    this.#kick();
    this.#o.onWritten?.(); // after #kick, so the callback can assemble into the buffer just released
  }

  async fsync(): Promise<number> {
    const t0 = process.hrtime.bigint();
    await new Promise<void>((resolve) => fs.fsync(this.#o.fd, () => resolve()));
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    this.fsyncCount++;
    this.fsyncMaxMs = Math.max(this.fsyncMaxMs, ms);
    return ms;
  }
}
