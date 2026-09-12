'use strict';
// Ledger trailer at EOF. PLAN §8.3.
//
// Layout:  "SIGTRLR1" | entryCount u32 | entryCount x 24-byte records | crc32c u32 | "SIGTRLR1"
// The magic is repeated at the end so the trailer is findable by scanning BACKWARD from EOF when the
// header was never finalised — a SIGKILLed recording has no trailerOffset in its header.

const D = require('../config/defaults');
const { crc32c } = require('./crc32c');

const MAGIC = D.TRAILER_MAGIC; // 8 ASCII bytes
const RECORD_BYTES = 24;

function encode(entries) {
  const size = 8 + 4 + entries.length * RECORD_BYTES + 4 + 8;
  const buf = Buffer.alloc(size);
  buf.write(MAGIC, 0, 8, 'latin1');
  buf.writeUInt32LE(entries.length, 8);
  let o = 12;
  for (const e of entries) {
    buf.writeBigUInt64LE(BigInt(e.startFrameIndex), o);
    buf.writeBigUInt64LE(BigInt(e.frameCount), o + 8);
    buf.writeUInt32LE(e.causeCode, o + 16);
    buf.writeUInt32LE(0, o + 20); // reserved
    o += RECORD_BYTES;
  }
  buf.writeUInt32LE(crc32c(buf, 0, o), o);
  buf.write(MAGIC, o + 4, 8, 'latin1');
  return buf;
}

function decode(buf) {
  if (buf.length < 24 || buf.toString('latin1', 0, 8) !== MAGIC) return null;
  const entryCount = buf.readUInt32LE(8);
  const end = 12 + entryCount * RECORD_BYTES;
  if (end + 12 > buf.length) return null;
  if (crc32c(buf, 0, end) !== buf.readUInt32LE(end)) return { crcOk: false, entries: [] };
  const entries = [];
  for (let i = 0, o = 12; i < entryCount; i++, o += RECORD_BYTES) {
    entries.push({
      startFrameIndex: Number(buf.readBigUInt64LE(o)),
      frameCount: Number(buf.readBigUInt64LE(o + 8)),
      causeCode: buf.readUInt32LE(o + 16),
    });
  }
  return { crcOk: true, entries };
}

module.exports = { MAGIC, RECORD_BYTES, encode, decode };
