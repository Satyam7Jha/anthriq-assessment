// Drop-ledger trailer at EOF.
//
//   "SIGTRLR1" | entryCount u32 | entryCount x 24-byte records | crc32c u32 | "SIGTRLR1"
//
// The magic is repeated at the end so a SIGKILLed file, whose header never recorded trailerOffset,
// can still have its trailer found by scanning backward from EOF.

import { DEFAULTS as D } from '../config/defaults.ts';
import { crc32c } from './crc32c.ts';

export const MAGIC = D.TRAILER_MAGIC;
export const RECORD_BYTES = 24;

export interface TrailerEntry {
  startFrameIndex: number;
  frameCount: number;
  causeCode: number;
}

export function encode(entries: TrailerEntry[]): Buffer {
  const buf = Buffer.alloc(8 + 4 + entries.length * RECORD_BYTES + 4 + 8);
  buf.write(MAGIC, 0, 8, 'latin1');
  buf.writeUInt32LE(entries.length, 8);
  let o = 12;
  for (const e of entries) {
    buf.writeBigUInt64LE(BigInt(e.startFrameIndex), o);
    buf.writeBigUInt64LE(BigInt(e.frameCount), o + 8);
    buf.writeUInt32LE(e.causeCode, o + 16);
    o += RECORD_BYTES;
  }
  buf.writeUInt32LE(crc32c(buf, 0, o), o);
  buf.write(MAGIC, o + 4, 8, 'latin1');
  return buf;
}

export function decode(buf: Buffer): { crcOk: boolean; entries: TrailerEntry[] } | null {
  if (buf.length < 24 || buf.toString('latin1', 0, 8) !== MAGIC) return null;
  const entryCount = buf.readUInt32LE(8);
  const end = 12 + entryCount * RECORD_BYTES;
  if (end + 12 > buf.length) return null;
  if (crc32c(buf, 0, end) !== buf.readUInt32LE(end)) return { crcOk: false, entries: [] };
  const entries: TrailerEntry[] = [];
  for (let i = 0, o = 12; i < entryCount; i++, o += RECORD_BYTES) {
    entries.push({
      startFrameIndex: Number(buf.readBigUInt64LE(o)),
      frameCount: Number(buf.readBigUInt64LE(o + 8)),
      causeCode: buf.readUInt32LE(o + 16),
    });
  }
  return { crcOk: true, entries };
}
