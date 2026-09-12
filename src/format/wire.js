'use strict';
// 32-byte wire block header. PLAN §4.1.
//
// Length-prefixed, self-delimiting blocks over a byte stream. Little-endian unconditionally: the
// wire is host-local by construction (AF_UNIX), so there is no byte-order negotiation to do. The
// FILE format does carry an endianness marker, because a file can travel.
//
// The field that matters most is startFrameIndex. It is absolute, monotonic, assigned by the
// scheduler BEFORE the generator's ring, and never renumbered. That is what lets the recorder report
// the POSITION of a loss (R18) with no side-channel: if the generator drops blocks [k, k+m), the
// recorder simply observes startFrameIndex jump, and the gap's start and length are both implied.

const D = require('../config/defaults');

const OFF = {
  magic: 0,
  version: 4,
  headerBytes: 6,
  startFrameIndex: 8,
  frameCount: 16,
  channelCount: 20,
  dtypeCode: 22,
  flags: 23,
  payloadBytes: 24,
  crc32c: 28,
};

const FLAG = {
  FIRST: 1 << 0,
  LAST: 1 << 1,
  AFTER_GEN_DROP: 1 << 2, // advisory only; the frameIndex gap is authoritative
};

const HEADER_BYTES = D.WIRE_HEADER_BYTES;

/** Write everything except the CRC, which needs the payload to already be in place. */
function writeHeaderNoCrc(buf, off, { startFrameIndex, frameCount, channelCount, dtypeCode, flags, payloadBytes }) {
  buf.writeUInt32LE(D.WIRE_MAGIC, off + OFF.magic);
  buf.writeUInt16LE(D.WIRE_VERSION, off + OFF.version);
  buf.writeUInt16LE(HEADER_BYTES, off + OFF.headerBytes);
  buf.writeBigUInt64LE(BigInt(startFrameIndex), off + OFF.startFrameIndex);
  buf.writeUInt32LE(frameCount, off + OFF.frameCount);
  buf.writeUInt16LE(channelCount, off + OFF.channelCount);
  buf.writeUInt8(dtypeCode, off + OFF.dtypeCode);
  buf.writeUInt8(flags | 0, off + OFF.flags);
  buf.writeUInt32LE(payloadBytes, off + OFF.payloadBytes);
}

/** Parse a header from `buf` at `off`. Does NOT verify the CRC — the caller needs the payload too. */
function readHeader(buf, off = 0) {
  const startBig = buf.readBigUInt64LE(off + OFF.startFrameIndex);
  // 2^53 frames at 4 kHz is 71,000 years, so this never fires. It is checked, not assumed.
  if (startBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`startFrameIndex ${startBig} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return {
    magic: buf.readUInt32LE(off + OFF.magic),
    version: buf.readUInt16LE(off + OFF.version),
    headerBytes: buf.readUInt16LE(off + OFF.headerBytes),
    startFrameIndex: Number(startBig),
    frameCount: buf.readUInt32LE(off + OFF.frameCount),
    channelCount: buf.readUInt16LE(off + OFF.channelCount),
    dtypeCode: buf.readUInt8(off + OFF.dtypeCode),
    flags: buf.readUInt8(off + OFF.flags),
    payloadBytes: buf.readUInt32LE(off + OFF.payloadBytes),
    crc32c: buf.readUInt32LE(off + OFF.crc32c),
  };
}

module.exports = { OFF, FLAG, HEADER_BYTES, writeHeaderNoCrc, readHeader };
