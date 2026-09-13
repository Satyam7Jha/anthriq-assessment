// 4,096-byte self-describing file header (PLAN §8.2) — what makes a recording interpretable without
// the source code. One page: room to grow without moving anything, and block 0 starts page-aligned.
//
//   endianness     the u32 0x01020304 written in file order. A little-endian read sees 0x01020304 for
//                  an LE file and 0x04030201 for BE, so readers must check rather than assume.
//   bytesPerValue  redundant with dtypeCode on purpose: a reader that does not know a future dtype
//                  can still compute the layout and skip it.

import { DEFAULTS as D } from '../config/defaults.ts';
import { crc32c } from './crc32c.ts';

export const HEADER_BYTES = D.FILE_HEADER_BYTES;

export const OFF = {
  magic: 0, formatVersion: 8, headerBytes: 10, endianness: 12, recordingId: 16,
  channelCount: 32, sampleRateHz: 36, sampleRateExactHz: 40, dtypeCode: 48, bytesPerValue: 50,
  layoutCode: 52, framesPerBlock: 56, blockHeaderBytes: 60, blockStrideBytes: 64,
  totalFrames: 72, totalValues: 80, blockCount: 88, durationSeconds: 96,
  startTimestampUnixNanos: 104, endTimestampUnixNanos: 112, startMonotonicNanos: 120,
  trailerOffset: 128, trailerBytes: 136, flags: 140, droppedFramesTotal: 144, ledgerEntryCount: 152,
  ringBytes: 156, fsyncIntervalSeconds: 160, generatorTickNanos: 164,
  signalId: 168, producer: 200, description: 264, reserved: 520, headerCrc32c: 4092,
} as const;

export const FLAG = {
  FINALISED: 1 << 0,
  HAS_TRAILER: 1 << 1,
  HAD_DROPS: 1 << 2,
  LEDGER_TRUNCATED: 1 << 3,
  DITHER_DISABLED: 1 << 4,
} as const;

const DTYPE_NAME: Record<number, string> = { 1: 'float32', 2: 'float64', 3: 'int16', 4: 'int32' };
const LAYOUT_NAME: Record<number, string> = { 1: 'BLOCK_PLANAR', 2: 'BLOCK_INTERLEAVED' };

export interface FileHeaderInput {
  recordingId: Uint8Array;
  channelCount: number;
  sampleRateHz: number;
  sampleRateExactHz?: number;
  dtypeCode?: number;
  bytesPerValue?: number;
  layoutCode?: number;
  framesPerBlock: number;
  blockStrideBytes: number;
  totalFrames?: number;
  totalValues?: number;
  blockCount?: number;
  durationSeconds?: number;
  startTimestampUnixNanos?: bigint;
  endTimestampUnixNanos?: bigint;
  startMonotonicNanos?: bigint;
  trailerOffset?: number;
  trailerBytes?: number;
  flags?: number;
  droppedFramesTotal?: number;
  ledgerEntryCount?: number;
  ringBytes?: number;
  fsyncIntervalSeconds?: number;
  generatorTickNanos?: number;
  signalId?: string;
  producer?: string;
  description?: string;
}

export interface FileHeader {
  magic: string; formatVersion: number; headerBytes: number; endianness: number; recordingId: string;
  channelCount: number; sampleRateHz: number; sampleRateExactHz: number;
  dtypeCode: number; dtypeName: string; bytesPerValue: number; layoutCode: number; layoutName: string;
  framesPerBlock: number; blockHeaderBytes: number; blockStrideBytes: number;
  totalFrames: number; totalValues: number; blockCount: number; durationSeconds: number;
  startTimestampUnixNanos: bigint; endTimestampUnixNanos: bigint; startMonotonicNanos: bigint;
  trailerOffset: number; trailerBytes: number; flags: number;
  finalised: boolean; hasTrailer: boolean; hadDrops: boolean; ledgerTruncated: boolean; ditherDisabled: boolean;
  droppedFramesTotal: number; ledgerEntryCount: number; ringBytes: number; fsyncIntervalSeconds: number;
  generatorTickNanos: number; signalId: string; producer: string; description: string; headerCrc32c: number;
}

/** Anything that makes a file unreadable. Maps to validator exit code 3. */
export class UnreadableError extends Error {
  readonly unreadable = true;
  constructor(message: string) {
    super(message);
    this.name = 'UnreadableError';
  }
}

const writeAscii = (buf: Buffer, off: number, len: number, s = ''): void => {
  buf.fill(0, off, off + len);
  buf.write(s.slice(0, len), off, len, 'latin1');
};

const readAscii = (buf: Buffer, off: number, len: number): string => {
  const nul = buf.indexOf(0, off);
  return buf.toString('latin1', off, nul === -1 || nul > off + len ? off + len : nul);
};

/** Written twice per recording: at t=0 with FINALISED clear, and at shutdown with real totals. */
export function encode(h: FileHeaderInput): Buffer {
  const b = Buffer.alloc(HEADER_BYTES); // zero-filled: reserved MUST be zero
  const u64 = (v: number | bigint | undefined, off: number) => b.writeBigUInt64LE(BigInt(v ?? 0), off);
  b.write(D.FILE_MAGIC, OFF.magic, 8, 'latin1');
  b.writeUInt16LE(D.FORMAT_VERSION, OFF.formatVersion);
  b.writeUInt16LE(HEADER_BYTES, OFF.headerBytes);
  b.writeUInt32LE(D.ENDIAN_MARKER, OFF.endianness);
  Buffer.from(h.recordingId).copy(b, OFF.recordingId, 0, 16);
  b.writeUInt32LE(h.channelCount, OFF.channelCount);
  b.writeUInt32LE(Math.round(h.sampleRateHz), OFF.sampleRateHz);
  b.writeDoubleLE(h.sampleRateExactHz ?? h.sampleRateHz, OFF.sampleRateExactHz);
  b.writeUInt16LE(h.dtypeCode ?? D.DTYPE_CODE, OFF.dtypeCode);
  b.writeUInt16LE(h.bytesPerValue ?? D.BYTES_PER_VALUE, OFF.bytesPerValue);
  b.writeUInt32LE(h.layoutCode ?? D.LAYOUT_BLOCK_PLANAR, OFF.layoutCode);
  b.writeUInt32LE(h.framesPerBlock, OFF.framesPerBlock);
  b.writeUInt32LE(D.BLOCK_HEADER_BYTES, OFF.blockHeaderBytes);
  u64(h.blockStrideBytes, OFF.blockStrideBytes);
  u64(h.totalFrames, OFF.totalFrames);
  u64(h.totalValues, OFF.totalValues);
  u64(h.blockCount, OFF.blockCount);
  b.writeDoubleLE(h.durationSeconds ?? 0, OFF.durationSeconds);
  u64(h.startTimestampUnixNanos, OFF.startTimestampUnixNanos);
  u64(h.endTimestampUnixNanos, OFF.endTimestampUnixNanos);
  u64(h.startMonotonicNanos, OFF.startMonotonicNanos);
  u64(h.trailerOffset, OFF.trailerOffset);
  b.writeUInt32LE(h.trailerBytes ?? 0, OFF.trailerBytes);
  b.writeUInt32LE(h.flags ?? 0, OFF.flags);
  u64(h.droppedFramesTotal, OFF.droppedFramesTotal);
  b.writeUInt32LE(h.ledgerEntryCount ?? 0, OFF.ledgerEntryCount);
  b.writeUInt32LE(h.ringBytes ?? 0, OFF.ringBytes);
  b.writeUInt32LE(h.fsyncIntervalSeconds ?? 0, OFF.fsyncIntervalSeconds);
  b.writeUInt32LE(h.generatorTickNanos ?? 0, OFF.generatorTickNanos);
  writeAscii(b, OFF.signalId, 32, h.signalId);
  writeAscii(b, OFF.producer, 64, h.producer);
  writeAscii(b, OFF.description, 256, h.description);
  b.writeUInt32LE(crc32c(b, 0, OFF.headerCrc32c), OFF.headerCrc32c);
  return b;
}

export function decode(b: Buffer): FileHeader {
  if (b.length < HEADER_BYTES) throw new UnreadableError(`file shorter than a ${HEADER_BYTES}-byte header (${b.length} B)`);
  const magic = b.toString('latin1', 0, 8);
  if (magic !== D.FILE_MAGIC) throw new UnreadableError(`bad magic: expected "${D.FILE_MAGIC}", got ${JSON.stringify(magic)}`);
  const endianness = b.readUInt32LE(OFF.endianness);
  if (endianness !== D.ENDIAN_MARKER) {
    // Refuse rather than silently misread: there is no big-endian platform in scope to produce one.
    throw new UnreadableError(`file is big-endian (marker 0x${endianness.toString(16)}); only little-endian is supported`);
  }
  const formatVersion = b.readUInt16LE(OFF.formatVersion);
  if (formatVersion !== D.FORMAT_VERSION) throw new UnreadableError(`unsupported formatVersion ${formatVersion}`);
  const headerCrc32c = b.readUInt32LE(OFF.headerCrc32c);
  if (crc32c(b, 0, OFF.headerCrc32c) !== headerCrc32c) throw new UnreadableError('header CRC-32C mismatch — the header is torn or corrupt');

  const u64 = (off: number) => Number(b.readBigUInt64LE(off));
  const flags = b.readUInt32LE(OFF.flags);
  const dtypeCode = b.readUInt16LE(OFF.dtypeCode);
  const layoutCode = b.readUInt32LE(OFF.layoutCode);
  return {
    magic, formatVersion, endianness, headerCrc32c,
    headerBytes: b.readUInt16LE(OFF.headerBytes),
    recordingId: b.subarray(OFF.recordingId, OFF.recordingId + 16).toString('hex'),
    channelCount: b.readUInt32LE(OFF.channelCount),
    sampleRateHz: b.readUInt32LE(OFF.sampleRateHz),
    sampleRateExactHz: b.readDoubleLE(OFF.sampleRateExactHz),
    dtypeCode, dtypeName: DTYPE_NAME[dtypeCode] ?? `unknown(${dtypeCode})`,
    bytesPerValue: b.readUInt16LE(OFF.bytesPerValue),
    layoutCode, layoutName: LAYOUT_NAME[layoutCode] ?? 'unknown',
    framesPerBlock: b.readUInt32LE(OFF.framesPerBlock),
    blockHeaderBytes: b.readUInt32LE(OFF.blockHeaderBytes),
    blockStrideBytes: u64(OFF.blockStrideBytes),
    totalFrames: u64(OFF.totalFrames),
    totalValues: u64(OFF.totalValues),
    blockCount: u64(OFF.blockCount),
    durationSeconds: b.readDoubleLE(OFF.durationSeconds),
    startTimestampUnixNanos: b.readBigUInt64LE(OFF.startTimestampUnixNanos),
    endTimestampUnixNanos: b.readBigUInt64LE(OFF.endTimestampUnixNanos),
    startMonotonicNanos: b.readBigUInt64LE(OFF.startMonotonicNanos),
    trailerOffset: u64(OFF.trailerOffset),
    trailerBytes: b.readUInt32LE(OFF.trailerBytes),
    flags,
    finalised: (flags & FLAG.FINALISED) !== 0,
    hasTrailer: (flags & FLAG.HAS_TRAILER) !== 0,
    hadDrops: (flags & FLAG.HAD_DROPS) !== 0,
    ledgerTruncated: (flags & FLAG.LEDGER_TRUNCATED) !== 0,
    ditherDisabled: (flags & FLAG.DITHER_DISABLED) !== 0,
    droppedFramesTotal: u64(OFF.droppedFramesTotal),
    ledgerEntryCount: b.readUInt32LE(OFF.ledgerEntryCount),
    ringBytes: b.readUInt32LE(OFF.ringBytes),
    fsyncIntervalSeconds: b.readUInt32LE(OFF.fsyncIntervalSeconds),
    generatorTickNanos: b.readUInt32LE(OFF.generatorTickNanos),
    signalId: readAscii(b, OFF.signalId, 32),
    producer: readAscii(b, OFF.producer, 64),
    description: readAscii(b, OFF.description, 256),
  };
}
