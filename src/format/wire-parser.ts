// Stream framing, CRC verification, and gap/duplicate detection (PLAN §4.4).
//
// One integer of state — expectedNext — and the same three-line rule the validator uses. That
// symmetry is deliberate: if recorder and validator disagree, one of them has a bug; the design is
// not ambiguous. Resynchronisation on a bad magic or CRC should never fire on SOCK_STREAM; it exists
// so a bug is loud and local instead of cascading.

import * as wire from './wire.ts';
import type { WireHeader } from './wire.ts';
import { DEFAULTS as D } from '../config/defaults.ts';
import { crc32cFinish, crc32cUpdate } from './crc32c.ts';

export interface WireParserHandlers {
  /** A CRC-valid block, in order. `payloadOffset` indexes into `buf`, which is only valid for this call. */
  onBlock: (hdr: WireHeader, buf: Buffer, payloadOffset: number, precedingGapFrames: number) => void;
  onGap?: (startFrameIndex: number, frameCount: number) => void;
  onDuplicate?: (startFrameIndex: number, frameCount: number) => void;
  onCorrupt?: (bytesSkipped: number, reason: string) => void;
}

export class WireParser {
  readonly stats = { blocks: 0, frames: 0, gaps: 0, gapFrames: 0, duplicates: 0, duplicateFrames: 0, corruptBytes: 0, crcFailures: 0 };
  #h: Required<WireParserHandlers>;
  #maxBlockBytes: number;
  // Carry-over for a block split across socket reads. Bounded: an unbounded concat would be a queue.
  #carry: Buffer;
  #carryLen = 0;
  #expectedNext: number | null = null;

  constructor(maxBlockBytes: number, handlers: WireParserHandlers) {
    this.#maxBlockBytes = maxBlockBytes;
    this.#carry = Buffer.allocUnsafeSlow(maxBlockBytes * 2);
    this.#h = { onGap: () => {}, onDuplicate: () => {}, onCorrupt: () => {}, ...handlers };
  }

  /** Feed one socket chunk. Synchronous and allocation-free in the steady state. */
  push(chunk: Buffer): void {
    let buf = chunk;
    let len = chunk.length;
    if (this.#carryLen > 0) {
      if (this.#carryLen + chunk.length > this.#carry.length) {
        this.#corrupt(this.#carryLen, 'carry-overflow'); // impossible with a well-formed peer
        this.#carryLen = 0;
      } else {
        chunk.copy(this.#carry, this.#carryLen);
        buf = this.#carry;
        len = this.#carryLen + chunk.length;
      }
    }

    let off = 0;
    while (len - off >= wire.HEADER_BYTES) {
      if (buf.readUInt32LE(off) !== D.WIRE_MAGIC) {
        off = this.#resync(buf, off, len);
        continue;
      }
      const hdr = wire.readHeader(buf, off);
      if (hdr.payloadBytes > this.#maxBlockBytes || hdr.headerBytes !== wire.HEADER_BYTES) {
        this.#corrupt(1, 'implausible-header');
        off += 1;
        continue;
      }
      const total = wire.HEADER_BYTES + hdr.payloadBytes;
      if (len - off < total) break; // incomplete; wait for more bytes
      const state = crc32cUpdate(buf, off, off + wire.OFF.crc32c);
      if (crc32cFinish(crc32cUpdate(buf, off + wire.HEADER_BYTES, off + total, state)) !== hdr.crc32c) {
        this.stats.crcFailures++;
        this.#corrupt(1, 'crc-mismatch');
        off += 1; // never trust the declared length of a bad block
        continue;
      }
      this.#sequence(hdr, buf, off + wire.HEADER_BYTES);
      off += total;
    }

    const remaining = len - off;
    if (remaining > 0) buf.copy(this.#carry, 0, off, len);
    this.#carryLen = remaining;
  }

  #corrupt(bytes: number, reason: string): void {
    this.stats.corruptBytes += bytes;
    this.#h.onCorrupt(bytes, reason);
  }

  /** Scan forward for the next magic. Returns the new offset, or `len` if there is none. */
  #resync(buf: Buffer, from: number, len: number): number {
    for (let i = from + 1; i + 4 <= len; i++) {
      if (buf.readUInt32LE(i) === D.WIRE_MAGIC) {
        this.#corrupt(i - from, 'resync');
        return i;
      }
    }
    const skipped = Math.max(0, len - from - 3);
    if (skipped > 0) this.#corrupt(skipped, 'resync-exhausted');
    return len;
  }

  /** The three-line classification rule, mirrored exactly by the validator. */
  #sequence(hdr: WireHeader, buf: Buffer, payloadOffset: number): void {
    const expected = this.#expectedNext ?? hdr.startFrameIndex;
    if (hdr.startFrameIndex >= expected) {
      const gap = hdr.startFrameIndex - expected;
      if (gap > 0) {
        this.stats.gaps++;
        this.stats.gapFrames += gap;
        this.#h.onGap(expected, gap);
      }
      this.#accept(hdr, buf, payloadOffset, gap);
      this.#expectedNext = hdr.startFrameIndex + hdr.frameCount;
      return;
    }
    // Earlier than expected: a duplicate or overlap. Keep only the genuinely new tail, so the file
    // stays strictly monotonic in frame index.
    const overlap = Math.min(expected - hdr.startFrameIndex, hdr.frameCount);
    this.stats.duplicates++;
    this.stats.duplicateFrames += overlap;
    this.#h.onDuplicate(hdr.startFrameIndex, overlap);
    const tail = hdr.startFrameIndex + hdr.frameCount - expected;
    if (tail <= 0) return;
    const bytesPerFrame = hdr.channelCount * 4;
    this.#accept(
      { ...hdr, startFrameIndex: expected, frameCount: tail, payloadBytes: tail * bytesPerFrame },
      buf,
      payloadOffset + (hdr.frameCount - tail) * bytesPerFrame,
      0
    );
    this.#expectedNext = hdr.startFrameIndex + hdr.frameCount;
  }

  #accept(hdr: WireHeader, buf: Buffer, payloadOffset: number, gap: number): void {
    this.stats.blocks++;
    this.stats.frames += hdr.frameCount;
    this.#h.onBlock(hdr, buf, payloadOffset, gap);
  }
}
