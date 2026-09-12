'use strict';
// 64-byte file block header. PLAN §8.3.
//
// The design property worth naming: each block is INDEPENDENTLY valid. It carries its own absolute
// startFrameIndex (not blockIndex * framesPerBlock, which would be false after a drop), its own
// frameCount (which is what makes a SHORT final block legal and self-describing), and two CRCs. A
// reader can therefore reconstruct the entire drop ledger from block headers alone, with no trailer
// and no sidecar — the ledger is a convenience and a cross-check, not load-bearing.

const D = require('../config/defaults');
const { crc32c } = require('./crc32c');

const OFF = {
  blockMagic: 0,
  startFrameIndex: 4,
  frameCount: 12,
  payloadBytes: 16,
  blockIndex: 20,
  monotonicNanos: 28,
  flags: 36,
  precedingGapFrames: 40,
  reserved: 44, // 12 B
  payloadCrc32c: 56,
  headerCrc32c: 60,
};

const FLAG = {
  SHORT_BLOCK: 1 << 0,
  PRECEDED_BY_GAP: 1 << 1,
};

const HEADER_BYTES = D.BLOCK_HEADER_BYTES;

function encode(buf, off, b) {
  buf.fill(0, off, off + HEADER_BYTES);
  buf.writeUInt32LE(D.BLOCK_MAGIC, off + OFF.blockMagic);
  buf.writeBigUInt64LE(BigInt(b.startFrameIndex), off + OFF.startFrameIndex);
  buf.writeUInt32LE(b.frameCount, off + OFF.frameCount);
  buf.writeUInt32LE(b.payloadBytes, off + OFF.payloadBytes);
  buf.writeBigUInt64LE(BigInt(b.blockIndex), off + OFF.blockIndex);
  buf.writeBigUInt64LE(BigInt(b.monotonicNanos), off + OFF.monotonicNanos);
  buf.writeUInt32LE(b.flags | 0, off + OFF.flags);
  buf.writeUInt32LE(b.precedingGapFrames | 0, off + OFF.precedingGapFrames);
  buf.writeUInt32LE(b.payloadCrc32c >>> 0, off + OFF.payloadCrc32c);
  buf.writeUInt32LE(crc32c(buf, off, off + 60), off + OFF.headerCrc32c);
}

function decode(buf, off = 0) {
  const h = {
    blockMagic: buf.readUInt32LE(off + OFF.blockMagic),
    startFrameIndex: Number(buf.readBigUInt64LE(off + OFF.startFrameIndex)),
    frameCount: buf.readUInt32LE(off + OFF.frameCount),
    payloadBytes: buf.readUInt32LE(off + OFF.payloadBytes),
    blockIndex: Number(buf.readBigUInt64LE(off + OFF.blockIndex)),
    monotonicNanos: buf.readBigUInt64LE(off + OFF.monotonicNanos),
    flags: buf.readUInt32LE(off + OFF.flags),
    precedingGapFrames: buf.readUInt32LE(off + OFF.precedingGapFrames),
    payloadCrc32c: buf.readUInt32LE(off + OFF.payloadCrc32c),
    headerCrc32c: buf.readUInt32LE(off + OFF.headerCrc32c),
  };
  h.magicOk = h.blockMagic === D.BLOCK_MAGIC;
  h.headerCrcOk = h.magicOk && crc32c(buf, off, off + 60) === h.headerCrc32c;
  return h;
}

module.exports = { OFF, FLAG, HEADER_BYTES, encode, decode };
