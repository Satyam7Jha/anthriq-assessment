// The recorder's bounded byte ring.
//
// One preallocated Buffer with head/tail offsets; wrap-around costs at most two copies. Allocated
// before the socket is accepted, so recorder RSS has no term that depends on run duration. At
// defaults 64 MiB absorbs ~131 s of write stall — about 600x the worst realistic macOS/APFS stall.

export type RingLevel = 'NORMAL' | 'ELEVATED' | 'HIGH';

export class ByteRing {
  readonly capacity: number;
  readonly buf: Buffer;
  #head = 0;
  #tail = 0;
  used = 0;
  peakUsed = 0;
  level: RingLevel = 'NORMAL';

  constructor(bytes: number) {
    this.capacity = bytes;
    this.buf = Buffer.allocUnsafeSlow(bytes);
  }

  get free(): number {
    return this.capacity - this.used;
  }
  get fillFraction(): number {
    return this.used / this.capacity;
  }

  /** Copy len bytes from src[start..] in. False, with nothing written, if they do not fit. */
  write(src: Buffer, start: number, len: number): boolean {
    if (len > this.free) return false;
    const first = Math.min(len, this.capacity - this.#head);
    src.copy(this.buf, this.#head, start, start + first);
    if (first < len) src.copy(this.buf, 0, start + first, start + len);
    this.#head = (this.#head + len) % this.capacity;
    this.used += len;
    this.peakUsed = Math.max(this.peakUsed, this.used);
    return true;
  }

  /** Copy len bytes out without consuming them. */
  peekInto(dst: Buffer, dstOffset: number, len: number): boolean {
    if (len > this.used) return false;
    const first = Math.min(len, this.capacity - this.#tail);
    this.buf.copy(dst, dstOffset, this.#tail, this.#tail + first);
    if (first < len) this.buf.copy(dst, dstOffset + first, 0, len - first);
    return true;
  }

  consume(len: number): void {
    this.#tail = (this.#tail + len) % this.capacity;
    this.used -= len;
  }

  /**
   * Watermarks with hysteresis — enter HIGH at 75%, return to NORMAL below 25% — so a ring hovering at
   * a threshold does not log once per block. Returns the new level on a transition, else null.
   */
  updateLevel(): RingLevel | null {
    const f = this.fillFraction;
    const next: RingLevel = f >= 0.75 ? 'HIGH' : f >= 0.25 ? (this.level === 'HIGH' ? 'HIGH' : 'ELEVATED') : 'NORMAL';
    if (next === this.level) return null;
    this.level = next;
    return next;
  }
}
