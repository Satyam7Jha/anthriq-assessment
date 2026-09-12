'use strict';
// CRC-32C (Castagnoli, polynomial 0x1EDC6F41, reflected form 0x82F63B78). PLAN §4.3.
//
// Why a checksum at all: without one, a corrupted block is indistinguishable from a block full of
// "incorrect values", which would muddy the validator's three-way classification (PLAN §10.3). A
// bit-rotted block reported as 128,000 incorrect values is technically true and diagnostically
// useless.
//
// Why CRC-32C and not SHA-256: we defend against bit-rot and truncation, not adversaries.
// node:crypto's Hash allocates an object per block, which is exactly the per-block allocation this
// design keeps off the hot path. The table is built once at module load; the hot loop allocates
// nothing.

const TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
  TABLE[i] = crc >>> 0;
}

/**
 * Incremental CRC-32C over a byte range.
 * @param {Uint8Array|Buffer} buf
 * @param {number} start inclusive
 * @param {number} end exclusive
 * @param {number} seed pass the previous result to continue a running CRC (see crc32cFinish)
 * @returns {number} the RAW running state; pass it to crc32cFinish, or chain it as the next seed.
 */
function crc32cUpdate(buf, start = 0, end = buf.length, seed = 0xffffffff) {
  let crc = seed >>> 0;
  for (let i = start; i < end; i++) crc = (crc >>> 8) ^ TABLE[(crc ^ buf[i]) & 0xff];
  return crc >>> 0;
}

/** Finalise a running state into the value that goes on the wire or on disk. */
function crc32cFinish(state) {
  return (state ^ 0xffffffff) >>> 0;
}

/** One-shot CRC-32C over a byte range. */
function crc32c(buf, start = 0, end = buf.length) {
  return crc32cFinish(crc32cUpdate(buf, start, end));
}

/**
 * CRC-32C over two disjoint ranges as if concatenated — used for "header bytes [0,28) followed by
 * the payload", which is how the wire block is checksummed without copying them together.
 */
function crc32cTwo(a, aStart, aEnd, b, bStart, bEnd) {
  return crc32cFinish(crc32cUpdate(b, bStart, bEnd, crc32cUpdate(a, aStart, aEnd)));
}

module.exports = { crc32c, crc32cUpdate, crc32cFinish, crc32cTwo, TABLE };
