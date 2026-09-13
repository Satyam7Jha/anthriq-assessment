// 64-byte file block header.
//
// Each block is independently valid: its own absolute startFrameIndex (not blockIndex *
// framesPerBlock, which is false after a drop), its own frameCount (which makes a short block legal)
// and two CRCs. A reader can rebuild the whole drop ledger from block headers alone.

import { DEFAULTS as D } from '../config/defaults.ts';
import { crc32c } from './crc32c.ts';

export const HEADER_BYTES = D.BLOCK_HEADER_BYTES;

export const OFF = {
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
} as const;

export const FLAG = { SHORT_BLOCK: 1 << 0, PRECEDED_BY_GAP: 1 << 1 } as const;

export interface BlockHeaderInput {
  startFrameIndex: number;
  frameCount: number;
  payloadBytes: number;
  blockIndex: number;
  monotonicNanos: bigint;
  flags: number;
  precedingGapFrames: number;
  payloadCrc32c: number;
}

export interface BlockHeader extends BlockHeaderInput {
  blockMagic: number;
  headerCrc32c: number;
  magicOk: boolean;
  headerCrcOk: boolean;
}

export function encode(buf: Buffer, off: number, b: BlockHeaderInput): void {
  buf.fill(0, off, off + HEADER_BYTES);
  buf.writeUInt32LE(D.BLOCK_MAGIC, off + OFF.blockMagic);
  buf.writeBigUInt64LE(BigInt(b.startFrameIndex), off + OFF.startFrameIndex);
  buf.writeUInt32LE(b.frameCount, off + OFF.frameCount);
  buf.writeUInt32LE(b.payloadBytes, off + OFF.payloadBytes);
  buf.writeBigUInt64LE(BigInt(b.blockIndex), off + OFF.blockIndex);
  buf.writeBigUInt64LE(b.monotonicNanos, off + OFF.monotonicNanos);
  buf.writeUInt32LE(b.flags | 0, off + OFF.flags);
  buf.writeUInt32LE(b.precedingGapFrames | 0, off + OFF.precedingGapFrames);
  buf.writeUInt32LE(b.payloadCrc32c >>> 0, off + OFF.payloadCrc32c);
  buf.writeUInt32LE(crc32c(buf, off, off + 60), off + OFF.headerCrc32c);
}

export function decode(buf: Buffer, off = 0): BlockHeader {
  const blockMagic = buf.readUInt32LE(off + OFF.blockMagic);
  const headerCrc32c = buf.readUInt32LE(off + OFF.headerCrc32c);
  const magicOk = blockMagic === D.BLOCK_MAGIC;
  return {
    blockMagic,
    startFrameIndex: Number(buf.readBigUInt64LE(off + OFF.startFrameIndex)),
    frameCount: buf.readUInt32LE(off + OFF.frameCount),
    payloadBytes: buf.readUInt32LE(off + OFF.payloadBytes),
    blockIndex: Number(buf.readBigUInt64LE(off + OFF.blockIndex)),
    monotonicNanos: buf.readBigUInt64LE(off + OFF.monotonicNanos),
    flags: buf.readUInt32LE(off + OFF.flags),
    precedingGapFrames: buf.readUInt32LE(off + OFF.precedingGapFrames),
    payloadCrc32c: buf.readUInt32LE(off + OFF.payloadCrc32c),
    headerCrc32c,
    magicOk,
    headerCrcOk: magicOk && crc32c(buf, off, off + 60) === headerCrc32c,
  };
}
