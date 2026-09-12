'use strict';
// The generator's fixed-slot block ring. PLAN §3.3 mechanism (2).
//
// Purpose: absorb consumer stalls so the generator's PACING never depends on the recorder's health.
// At defaults this is 1,024 slots x 2,592 B = 2.53 MiB = 5.12 s of absorption.
//
// Allocated ONCE as a single Buffer at startup. Blocks are written in place at a rotating offset, so
// there is zero allocation per tick and therefore zero GC pressure from the transport path.
//
// On full: DROP-OLDEST, and the victim's exact (startFrameIndex, frameCount) is returned so the
// caller can put it in the ledger. Oldest rather than newest because (a) the newest block is what
// the recorder needs to resynchronise on soonest, (b) dropping oldest leaves ONE clean monotonic gap
// so the recorder's detector produces one coalesced ledger entry per stall rather than an
// interleaved mess, and (c) stale signal data has no value in an instrument context — recency wins.
// Note this is the OPPOSITE choice from the recorder's ring (PLAN §7.4), for stated reasons: the
// generator's job is to stay on time, the recorder's is to keep the file monotonic.

class BlockRing {
  constructor({ slots, slotBytes }) {
    if (!(slots > 0) || !(slotBytes > 0)) throw new RangeError('slots and slotBytes must be positive');
    this.slots = slots;
    this.slotBytes = slotBytes;
    // allocUnsafeSlow, not allocUnsafe: pooled buffers carry an arbitrary byteOffset into a shared
    // ArrayBuffer, and the generator overlays a Float32Array on each slot's payload. A non-pooled
    // buffer owns its ArrayBuffer at offset 0, so typed-array alignment is guaranteed rather than
    // hoped for. Allocated ONCE, at startup.
    this.buf = Buffer.allocUnsafeSlow(slots * slotBytes);
    if (this.buf.byteOffset % 8 !== 0) throw new Error('ring buffer is not 8-byte aligned');
    if (slotBytes % 4 !== 0) throw new RangeError(`slotBytes ${slotBytes} must be a multiple of 4`);
    this.starts = new Float64Array(slots); // startFrameIndex per slot (exact integers to 2^53)
    this.frames = new Uint32Array(slots); // frameCount per slot
    this.lengths = new Uint32Array(slots); // used bytes per slot (short final blocks are legal)
    this.head = 0; // next slot to write
    this.count = 0; // filled slots
    this.droppedBlocks = 0;
    this.peakCount = 0;
  }

  get isFull() {
    return this.count === this.slots;
  }
  get isEmpty() {
    return this.count === 0;
  }
  get fillFraction() {
    return this.count / this.slots;
  }

  /** Byte offset of the slot the next commit() will claim. The caller writes directly into .buf. */
  reserveOffset() {
    return this.head * this.slotBytes;
  }

  /**
   * Claim the reserved slot. If the ring is full, the OLDEST block is evicted first and returned as
   * `{startFrameIndex, frameCount}` so the caller can record a positioned drop. The new block always
   * gets in.
   */
  commit(startFrameIndex, frameCount, byteLength) {
    let victim = null;
    if (this.isFull) {
      const tail = (this.head - this.count + this.slots) % this.slots;
      victim = { startFrameIndex: this.starts[tail], frameCount: this.frames[tail] };
      this.count--;
      this.droppedBlocks++;
    }
    this.starts[this.head] = startFrameIndex;
    this.frames[this.head] = frameCount;
    this.lengths[this.head] = byteLength;
    this.head = (this.head + 1) % this.slots;
    this.count++;
    if (this.count > this.peakCount) this.peakCount = this.count;
    return victim;
  }

  /** The oldest block, as a zero-copy subarray view. Valid until the slot is overwritten. */
  peek() {
    if (this.isEmpty) return null;
    const tail = (this.head - this.count + this.slots) % this.slots;
    const off = tail * this.slotBytes;
    return {
      bytes: this.buf.subarray(off, off + this.lengths[tail]),
      startFrameIndex: this.starts[tail],
      frameCount: this.frames[tail],
    };
  }

  pop() {
    if (this.isEmpty) return false;
    this.count--;
    return true;
  }
}

module.exports = { BlockRing };
