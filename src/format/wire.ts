// 32-byte wire block header. Little-endian unconditionally: the wire is host-local.
//
// The field that matters is startFrameIndex: absolute, monotonic, assigned by the scheduler before
// the generator's ring, never renumbered. That is what lets the recorder report the POSITION of a loss
// with no side channel — a dropped range shows up as a jump in startFrameIndex.

import { DEFAULTS as D } from '../config/defaults.ts';

export const HEADER_BYTES = D.WIRE_HEADER_BYTES;

export const OFF = {
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
} as const;

export const FLAG = { FIRST: 1 << 0, LAST: 1 << 1, AFTER_GEN_DROP: 1 << 2 } as const;

export interface WireHeader {
  magic: number;
  version: number;
  headerBytes: number;
  startFrameIndex: number;
  frameCount: number;
  channelCount: number;
  dtypeCode: number;
  flags: number;
  payloadBytes: number;
  crc32c: number;
}

export type WireHeaderInput = Pick<WireHeader, 'startFrameIndex' | 'frameCount' | 'channelCount' | 'dtypeCode' | 'flags' | 'payloadBytes'>;

/** Everything except the CRC, which needs the payload in place first. */
export function writeHeaderNoCrc(buf: Buffer, off: number, h: WireHeaderInput): void {
  buf.writeUInt32LE(D.WIRE_MAGIC, off + OFF.magic);
  buf.writeUInt16LE(D.WIRE_VERSION, off + OFF.version);
  buf.writeUInt16LE(HEADER_BYTES, off + OFF.headerBytes);
  buf.writeBigUInt64LE(BigInt(h.startFrameIndex), off + OFF.startFrameIndex);
  buf.writeUInt32LE(h.frameCount, off + OFF.frameCount);
  buf.writeUInt16LE(h.channelCount, off + OFF.channelCount);
  buf.writeUInt8(h.dtypeCode, off + OFF.dtypeCode);
  buf.writeUInt8(h.flags | 0, off + OFF.flags);
  buf.writeUInt32LE(h.payloadBytes, off + OFF.payloadBytes);
}

export function readHeader(buf: Buffer, off = 0): WireHeader {
  const start = buf.readBigUInt64LE(off + OFF.startFrameIndex);
  // 2^53 frames at 4 kHz is 71,000 years; checked, not assumed.
  if (start > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`startFrameIndex ${start} exceeds 2^53`);
  return {
    magic: buf.readUInt32LE(off + OFF.magic),
    version: buf.readUInt16LE(off + OFF.version),
    headerBytes: buf.readUInt16LE(off + OFF.headerBytes),
    startFrameIndex: Number(start),
    frameCount: buf.readUInt32LE(off + OFF.frameCount),
    channelCount: buf.readUInt16LE(off + OFF.channelCount),
    dtypeCode: buf.readUInt8(off + OFF.dtypeCode),
    flags: buf.readUInt8(off + OFF.flags),
    payloadBytes: buf.readUInt32LE(off + OFF.payloadBytes),
    crc32c: buf.readUInt32LE(off + OFF.crc32c),
  };
}
