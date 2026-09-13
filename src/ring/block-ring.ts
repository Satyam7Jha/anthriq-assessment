// The generator's fixed-slot block ring (PLAN §3.3).
//
// Absorbs consumer stalls so the generator's pacing never depends on the recorder: 1,024 slots x
// 2,592 B = 2.53 MiB = 5.12 s at defaults. Allocated once; blocks are written in place, so the
// transport path allocates nothing per tick.
//
// Full ring: DROP-OLDEST, returning the victim's exact position for the ledger. Oldest, because the
// newest block is what the recorder resynchronises on, and dropping the oldest leaves one clean
// monotonic gap. (The recorder makes the opposite choice for its own reasons — PLAN §7.4.)

export interface Victim {
  startFrameIndex: number;
  frameCount: number;
}

export class BlockRing {
  readonly slots: number;
  readonly slotBytes: number;
  readonly buf: Buffer;
  #starts: Float64Array;
  #frames: Uint32Array;
  #lengths: Uint32Array;
  #head = 0;
  #count = 0;
  peakCount = 0;
  droppedBlocks = 0;

  constructor(slots: number, slotBytes: number) {
    if (!(slots > 0) || !(slotBytes > 0)) throw new RangeError('slots and slotBytes must be positive');
    if (slotBytes % 4 !== 0) throw new RangeError(`slotBytes ${slotBytes} must be a multiple of 4`);
    this.slots = slots;
    this.slotBytes = slotBytes;
    // Non-pooled, so the buffer owns its ArrayBuffer at offset 0 and the generator can overlay a
    // Float32Array with guaranteed alignment.
    this.buf = Buffer.allocUnsafeSlow(slots * slotBytes);
    this.#starts = new Float64Array(slots);
    this.#frames = new Uint32Array(slots);
    this.#lengths = new Uint32Array(slots);
  }

  get isEmpty(): boolean {
    return this.#count === 0;
  }
  get fillFraction(): number {
    return this.#count / this.slots;
  }

  /** Byte offset of the slot the next commit() claims. The caller writes into `buf` there. */
  reserveOffset(): number {
    return this.#head * this.slotBytes;
  }

  #tail(): number {
    return (this.#head - this.#count + this.slots) % this.slots;
  }

  /** Claim the reserved slot. On a full ring, evicts and returns the oldest block. */
  commit(startFrameIndex: number, frameCount: number, byteLength: number): Victim | null {
    let victim: Victim | null = null;
    if (this.#count === this.slots) {
      const t = this.#tail();
      victim = { startFrameIndex: this.#starts[t], frameCount: this.#frames[t] };
      this.#count--;
      this.droppedBlocks++;
    }
    this.#starts[this.#head] = startFrameIndex;
    this.#frames[this.#head] = frameCount;
    this.#lengths[this.#head] = byteLength;
    this.#head = (this.#head + 1) % this.slots;
    this.#count++;
    this.peakCount = Math.max(this.peakCount, this.#count);
    return victim;
  }

  /** The oldest block as a zero-copy view, valid until its slot is overwritten. */
  peek(): Buffer | null {
    if (this.#count === 0) return null;
    const off = this.#tail() * this.slotBytes;
    return this.buf.subarray(off, off + this.#lengths[this.#tail()]);
  }

  pop(): boolean {
    if (this.#count === 0) return false;
    this.#count--;
    return true;
  }
}
