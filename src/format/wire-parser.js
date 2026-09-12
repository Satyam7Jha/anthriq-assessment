'use strict';
// Stream framing, CRC verification, and gap/duplicate detection. PLAN §4.4.
//
// The recorder keeps exactly ONE integer of state — expectedNext — and the same three-line rule is
// implemented by the validator (PLAN §10.3). That symmetry is deliberate: a disagreement between
// recorder and validator is then a bug in one of them, not an ambiguity in the design.
//
// Framing resynchronisation: if a header's magic or CRC fails, scan forward byte by byte for the
// next magic and validate the candidate. On a SOCK_STREAM this should never trigger — the transport
// is lossless and ordered — so it exists to make a bug LOUD and LOCALISED instead of cascading.

const wire = require('./wire');
const { WIRE_MAGIC } = require('../config/defaults');
const { crc32cUpdate, crc32cFinish } = require('./crc32c');

const EVENT = { BLOCK: 1, GAP: 2, DUPLICATE: 3, CORRUPT: 4 };

class WireParser {
  /**
   * @param {object} o
   * @param {number} o.maxBlockBytes cap on a declared payload size — a corrupt length field must not
   *                                 be able to make us allocate arbitrarily.
   * @param {(hdr, payload, payloadOffset) => void} o.onBlock
   * @param {(startFrameIndex, frameCount) => void} o.onGap
   * @param {(startFrameIndex, frameCount) => void} o.onDuplicate
   * @param {(bytesSkipped, reason) => void} o.onCorrupt
   */
  constructor({ maxBlockBytes, onBlock, onGap = () => {}, onDuplicate = () => {}, onCorrupt = () => {} }) {
    this.maxBlockBytes = maxBlockBytes;
    this.onBlock = onBlock;
    this.onGap = onGap;
    this.onDuplicate = onDuplicate;
    this.onCorrupt = onCorrupt;
    // Carry-over buffer for a block split across socket reads. Bounded by maxBlockBytes; a stream
    // parser that concatenated Buffers without a bound would itself be an unbounded queue.
    this.carry = Buffer.allocUnsafeSlow(maxBlockBytes * 2);
    this.carryLen = 0;
    this.expectedNext = null; // null until the first block establishes the origin
    this.stats = { blocks: 0, frames: 0, gaps: 0, gapFrames: 0, duplicates: 0, duplicateFrames: 0, corruptBytes: 0, crcFailures: 0 };
  }

  /** Feed one socket chunk. Synchronous, allocation-free in the steady state. */
  push(chunk) {
    let buf;
    let len;
    if (this.carryLen === 0) {
      buf = chunk;
      len = chunk.length;
    } else {
      if (this.carryLen + chunk.length > this.carry.length) {
        // Cannot happen with a well-formed peer: carry only ever holds one partial block.
        this.onCorrupt(this.carryLen, 'carry-overflow');
        this.stats.corruptBytes += this.carryLen;
        this.carryLen = 0;
        buf = chunk;
        len = chunk.length;
      } else {
        chunk.copy(this.carry, this.carryLen);
        buf = this.carry;
        len = this.carryLen + chunk.length;
      }
    }

    let off = 0;
    for (;;) {
      if (len - off < wire.HEADER_BYTES) break;
      if (buf.readUInt32LE(off) !== WIRE_MAGIC) {
        off = this.#resync(buf, off, len);
        if (off < 0) {
          off = len;
          break;
        }
        continue;
      }
      const hdr = wire.readHeader(buf, off);
      if (hdr.payloadBytes > this.maxBlockBytes || hdr.headerBytes !== wire.HEADER_BYTES) {
        this.onCorrupt(1, 'implausible-header');
        this.stats.corruptBytes += 1;
        off += 1;
        continue;
      }
      const total = wire.HEADER_BYTES + hdr.payloadBytes;
      if (len - off < total) break; // incomplete; wait for more bytes

      const state = crc32cUpdate(buf, off, off + wire.OFF.crc32c);
      const crc = crc32cFinish(crc32cUpdate(buf, off + wire.HEADER_BYTES, off + total, state));
      if (crc !== hdr.crc32c) {
        this.stats.crcFailures++;
        this.onCorrupt(1, 'crc-mismatch');
        this.stats.corruptBytes += 1;
        off += 1; // resync from the next byte; do NOT trust the declared length of a bad block
        continue;
      }

      this.#sequence(hdr, buf, off + wire.HEADER_BYTES);
      off += total;
    }

    // Preserve the unconsumed tail for the next chunk.
    const remaining = len - off;
    if (remaining > 0) {
      if (buf === this.carry) this.carry.copy(this.carry, 0, off, len);
      else buf.copy(this.carry, 0, off, len);
    }
    this.carryLen = remaining;
  }

  /** Scan forward for the next plausible magic. Returns the new offset, or -1 if none in range. */
  #resync(buf, from, len) {
    for (let i = from + 1; i + 4 <= len; i++) {
      if (buf.readUInt32LE(i) === WIRE_MAGIC) {
        const skipped = i - from;
        this.stats.corruptBytes += skipped;
        this.onCorrupt(skipped, 'resync');
        return i;
      }
    }
    const skipped = Math.max(0, len - from - 3);
    if (skipped > 0) {
      this.stats.corruptBytes += skipped;
      this.onCorrupt(skipped, 'resync-exhausted');
    }
    return -1;
  }

  /** The three-line classification rule. Mirrored exactly by the validator. */
  #sequence(hdr, buf, payloadOffset) {
    if (this.expectedNext === null) this.expectedNext = hdr.startFrameIndex;

    if (hdr.startFrameIndex === this.expectedNext) {
      // Contiguous — the only nominal path.
      this.#accept(hdr, buf, payloadOffset, 0);
      this.expectedNext = hdr.startFrameIndex + hdr.frameCount;
      return;
    }

    if (hdr.startFrameIndex > this.expectedNext) {
      const gap = hdr.startFrameIndex - this.expectedNext;
      this.stats.gaps++;
      this.stats.gapFrames += gap;
      this.onGap(this.expectedNext, gap);
      this.#accept(hdr, buf, payloadOffset, gap);
      this.expectedNext = hdr.startFrameIndex + hdr.frameCount;
      return;
    }

    // startFrameIndex < expectedNext: DUPLICATE or OVERLAP. Cannot occur on SOCK_STREAM; it means a
    // generator restarted against a live recorder, or a framing bug. Either way, report it.
    const overlap = Math.min(this.expectedNext - hdr.startFrameIndex, hdr.frameCount);
    this.stats.duplicates++;
    this.stats.duplicateFrames += overlap;
    this.onDuplicate(hdr.startFrameIndex, overlap);
    const tail = hdr.startFrameIndex + hdr.frameCount - this.expectedNext;
    if (tail > 0) {
      // Keep only the genuinely new part, so the file stays strictly monotonic in frameIndex.
      const skipFrames = hdr.frameCount - tail;
      const bytesPerFrame = hdr.channelCount * 4;
      this.#accept(
        { ...hdr, startFrameIndex: this.expectedNext, frameCount: tail, payloadBytes: tail * bytesPerFrame },
        buf,
        payloadOffset + skipFrames * bytesPerFrame,
        0
      );
      this.expectedNext = hdr.startFrameIndex + hdr.frameCount;
    }
    // else: wholly duplicate — discard entirely, expectedNext unchanged.
  }

  #accept(hdr, buf, payloadOffset, precedingGapFrames) {
    this.stats.blocks++;
    this.stats.frames += hdr.frameCount;
    this.onBlock(hdr, buf, payloadOffset, precedingGapFrames);
  }
}

module.exports = { WireParser, EVENT };
