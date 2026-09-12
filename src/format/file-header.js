'use strict';
// 4,096-byte self-describing file header. PLAN §8.2.
//
// This is the artifact that satisfies "a recording must be FULLY INTERPRETABLE WITHOUT REFERENCE TO
// THE SOURCE CODE". 4,096 bytes because it is one page: it leaves room for future fields without
// moving anything, and it aligns block 0 to a page boundary, which matters for pread efficiency.
//
// Two fields deserve explanation:
//   endianness      written as the u32 0x01020304 IN FILE ORDER. A reader doing a little-endian read
//                   sees 0x01020304 if the file is LE, 0x04030201 if it is BE. A reader must CHECK
//                   this rather than assume, which is why it is a marker and not a boolean.
//   bytesPerValue   redundant with dtypeCode BY DESIGN. A reader that does not recognise a future
//                   dtypeCode can still compute the layout and skip correctly.

const D = require('../config/defaults');
const { crc32c } = require('./crc32c');

const HEADER_BYTES = D.FILE_HEADER_BYTES;

const OFF = {
  magic: 0, // char[8]
  formatVersion: 8,
  headerBytes: 10,
  endianness: 12,
  recordingId: 16, // u8[16]
  channelCount: 32,
  sampleRateHz: 36,
  sampleRateExactHz: 40, // f64
  dtypeCode: 48,
  bytesPerValue: 50,
  layoutCode: 52,
  framesPerBlock: 56,
  blockHeaderBytes: 60,
  blockStrideBytes: 64, // u64
  totalFrames: 72,
  totalValues: 80,
  blockCount: 88,
  durationSeconds: 96, // f64
  startTimestampUnixNanos: 104,
  endTimestampUnixNanos: 112,
  startMonotonicNanos: 120,
  trailerOffset: 128,
  trailerBytes: 136,
  flags: 140,
  droppedFramesTotal: 144,
  ledgerEntryCount: 152,
  ringBytes: 156,
  fsyncIntervalSeconds: 160,
  generatorTickNanos: 164,
  signalId: 168, // char[32]
  producer: 200, // char[64]
  description: 264, // char[256]
  reserved: 520,
  headerCrc32c: 4092,
};

const FLAG = {
  FINALISED: 1 << 0,
  HAS_TRAILER: 1 << 1,
  HAD_DROPS: 1 << 2,
  LEDGER_TRUNCATED: 1 << 3,
  DITHER_DISABLED: 1 << 4,
};

const DTYPE = {
  1: { name: 'float32', bytes: 4, endian: 'LE' },
  2: { name: 'float64', bytes: 8, endian: 'LE' },
  3: { name: 'int16', bytes: 2, endian: 'LE' },
  4: { name: 'int32', bytes: 4, endian: 'LE' },
};

const LAYOUT = { 1: 'BLOCK_PLANAR', 2: 'BLOCK_INTERLEAVED' };

function writeAscii(buf, off, len, str) {
  buf.fill(0, off, off + len);
  buf.write(String(str ?? '').slice(0, len), off, len, 'latin1');
}

function readAscii(buf, off, len) {
  const end = buf.indexOf(0, off);
  const stop = end === -1 || end > off + len ? off + len : end;
  return buf.toString('latin1', off, stop);
}

/**
 * Build the 4,096-byte header. Called twice per recording: once at t=0 with placeholder totals and
 * flags=0, and once at shutdown with real totals and FINALISED set. The FINALISED bit is what tells
 * every reader whether to trust totalFrames or to reconstruct it (PLAN §8.6).
 */
function encode(h) {
  const buf = Buffer.alloc(HEADER_BYTES); // zero-filled: `reserved` MUST be zero on write
  buf.write(D.FILE_MAGIC, OFF.magic, 8, 'latin1');
  buf.writeUInt16LE(h.formatVersion ?? D.FORMAT_VERSION, OFF.formatVersion);
  buf.writeUInt16LE(HEADER_BYTES, OFF.headerBytes);
  buf.writeUInt32LE(D.ENDIAN_MARKER, OFF.endianness);
  Buffer.from(h.recordingId).copy(buf, OFF.recordingId, 0, 16);
  buf.writeUInt32LE(h.channelCount, OFF.channelCount);
  buf.writeUInt32LE(Math.round(h.sampleRateHz), OFF.sampleRateHz);
  buf.writeDoubleLE(h.sampleRateExactHz ?? h.sampleRateHz, OFF.sampleRateExactHz);
  buf.writeUInt16LE(h.dtypeCode ?? D.DTYPE_CODE, OFF.dtypeCode);
  buf.writeUInt16LE(h.bytesPerValue ?? D.BYTES_PER_VALUE, OFF.bytesPerValue);
  buf.writeUInt32LE(h.layoutCode ?? D.LAYOUT_BLOCK_PLANAR, OFF.layoutCode);
  buf.writeUInt32LE(h.framesPerBlock, OFF.framesPerBlock);
  buf.writeUInt32LE(D.BLOCK_HEADER_BYTES, OFF.blockHeaderBytes);
  buf.writeBigUInt64LE(BigInt(h.blockStrideBytes), OFF.blockStrideBytes);
  buf.writeBigUInt64LE(BigInt(h.totalFrames ?? 0), OFF.totalFrames);
  buf.writeBigUInt64LE(BigInt(h.totalValues ?? 0), OFF.totalValues);
  buf.writeBigUInt64LE(BigInt(h.blockCount ?? 0), OFF.blockCount);
  buf.writeDoubleLE(h.durationSeconds ?? 0, OFF.durationSeconds);
  buf.writeBigUInt64LE(BigInt(h.startTimestampUnixNanos ?? 0), OFF.startTimestampUnixNanos);
  buf.writeBigUInt64LE(BigInt(h.endTimestampUnixNanos ?? 0), OFF.endTimestampUnixNanos);
  buf.writeBigUInt64LE(BigInt(h.startMonotonicNanos ?? 0), OFF.startMonotonicNanos);
  buf.writeBigUInt64LE(BigInt(h.trailerOffset ?? 0), OFF.trailerOffset);
  buf.writeUInt32LE(h.trailerBytes ?? 0, OFF.trailerBytes);
  buf.writeUInt32LE(h.flags ?? 0, OFF.flags);
  buf.writeBigUInt64LE(BigInt(h.droppedFramesTotal ?? 0), OFF.droppedFramesTotal);
  buf.writeUInt32LE(h.ledgerEntryCount ?? 0, OFF.ledgerEntryCount);
  buf.writeUInt32LE(h.ringBytes ?? 0, OFF.ringBytes);
  buf.writeUInt32LE(h.fsyncIntervalSeconds ?? 0, OFF.fsyncIntervalSeconds);
  buf.writeUInt32LE(Number(h.generatorTickNanos ?? 0), OFF.generatorTickNanos);
  writeAscii(buf, OFF.signalId, 32, h.signalId);
  writeAscii(buf, OFF.producer, 64, h.producer);
  writeAscii(buf, OFF.description, 256, h.description);
  buf.writeUInt32LE(crc32c(buf, 0, OFF.headerCrc32c), OFF.headerCrc32c);
  return buf;
}

/** Thrown for anything that makes a file unreadable — maps to validator exit code 3. */
class UnreadableError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'UnreadableError';
    this.unreadable = true;
  }
}

function decode(buf) {
  if (buf.length < HEADER_BYTES) {
    throw new UnreadableError(`file shorter than a ${HEADER_BYTES}-byte header (${buf.length} B)`);
  }
  const magic = buf.toString('latin1', 0, 8);
  if (magic !== D.FILE_MAGIC) {
    throw new UnreadableError(`bad magic: expected "${D.FILE_MAGIC}", got ${JSON.stringify(magic)}`);
  }
  const endianness = buf.readUInt32LE(OFF.endianness);
  if (endianness !== D.ENDIAN_MARKER) {
    // A big-endian file would need every field byte-swapped. We detect and refuse rather than
    // silently misread — there is no BE platform in this project's scope to produce one.
    throw new UnreadableError(
      `file is big-endian (marker 0x${endianness.toString(16)}); this reader only handles little-endian`
    );
  }
  const formatVersion = buf.readUInt16LE(OFF.formatVersion);
  if (formatVersion !== D.FORMAT_VERSION) {
    throw new UnreadableError(`unsupported formatVersion ${formatVersion} (this reader knows ${D.FORMAT_VERSION})`);
  }
  const storedCrc = buf.readUInt32LE(OFF.headerCrc32c);
  const headerCrcOk = crc32c(buf, 0, OFF.headerCrc32c) === storedCrc;
  if (!headerCrcOk) throw new UnreadableError('header CRC-32C mismatch — the header is torn or corrupt');

  const flags = buf.readUInt32LE(OFF.flags);
  const dtypeCode = buf.readUInt16LE(OFF.dtypeCode);
  const h = {
    magic,
    formatVersion,
    headerBytes: buf.readUInt16LE(OFF.headerBytes),
    endianness,
    recordingId: buf.subarray(OFF.recordingId, OFF.recordingId + 16).toString('hex'),
    channelCount: buf.readUInt32LE(OFF.channelCount),
    sampleRateHz: buf.readUInt32LE(OFF.sampleRateHz),
    sampleRateExactHz: buf.readDoubleLE(OFF.sampleRateExactHz),
    dtypeCode,
    dtypeName: DTYPE[dtypeCode]?.name ?? `unknown(${dtypeCode})`,
    bytesPerValue: buf.readUInt16LE(OFF.bytesPerValue),
    layoutCode: buf.readUInt32LE(OFF.layoutCode),
    layoutName: LAYOUT[buf.readUInt32LE(OFF.layoutCode)] ?? 'unknown',
    framesPerBlock: buf.readUInt32LE(OFF.framesPerBlock),
    blockHeaderBytes: buf.readUInt32LE(OFF.blockHeaderBytes),
    blockStrideBytes: Number(buf.readBigUInt64LE(OFF.blockStrideBytes)),
    totalFrames: Number(buf.readBigUInt64LE(OFF.totalFrames)),
    totalValues: Number(buf.readBigUInt64LE(OFF.totalValues)),
    blockCount: Number(buf.readBigUInt64LE(OFF.blockCount)),
    durationSeconds: buf.readDoubleLE(OFF.durationSeconds),
    startTimestampUnixNanos: buf.readBigUInt64LE(OFF.startTimestampUnixNanos),
    endTimestampUnixNanos: buf.readBigUInt64LE(OFF.endTimestampUnixNanos),
    startMonotonicNanos: buf.readBigUInt64LE(OFF.startMonotonicNanos),
    trailerOffset: Number(buf.readBigUInt64LE(OFF.trailerOffset)),
    trailerBytes: buf.readUInt32LE(OFF.trailerBytes),
    flags,
    finalised: (flags & FLAG.FINALISED) !== 0,
    hasTrailer: (flags & FLAG.HAS_TRAILER) !== 0,
    hadDrops: (flags & FLAG.HAD_DROPS) !== 0,
    ledgerTruncated: (flags & FLAG.LEDGER_TRUNCATED) !== 0,
    ditherDisabled: (flags & FLAG.DITHER_DISABLED) !== 0,
    droppedFramesTotal: Number(buf.readBigUInt64LE(OFF.droppedFramesTotal)),
    ledgerEntryCount: buf.readUInt32LE(OFF.ledgerEntryCount),
    ringBytes: buf.readUInt32LE(OFF.ringBytes),
    fsyncIntervalSeconds: buf.readUInt32LE(OFF.fsyncIntervalSeconds),
    generatorTickNanos: buf.readUInt32LE(OFF.generatorTickNanos),
    signalId: readAscii(buf, OFF.signalId, 32),
    producer: readAscii(buf, OFF.producer, 64),
    description: readAscii(buf, OFF.description, 256),
    headerCrc32c: storedCrc,
    headerCrcOk,
  };
  return h;
}

module.exports = { OFF, FLAG, DTYPE, LAYOUT, HEADER_BYTES, encode, decode, UnreadableError };
