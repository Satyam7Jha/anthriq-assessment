// The on-disk and on-wire codecs round-trip, and the checksum is the standard one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32c } from '../src/format/crc32c.ts';
import * as fileHeader from '../src/format/file-header.ts';
import * as blockHeader from '../src/format/block-header.ts';
import * as trailer from '../src/format/trailer.ts';
import * as wire from '../src/format/wire.ts';

test('CRC-32C matches the standard check value', () => {
  assert.equal(crc32c(Buffer.from('123456789')), 0xe3069283);
});

test('file header round-trips and rejects damage', () => {
  const buf = fileHeader.encode({
    recordingId: Buffer.alloc(16, 7),
    channelCount: 32,
    sampleRateHz: 4000,
    framesPerBlock: 4000,
    blockStrideBytes: 512_064,
    totalFrames: 14_400_000,
    totalValues: 460_800_000,
    startTimestampUnixNanos: 123n,
    signalId: 'tri+saw+hash32/v1',
    flags: fileHeader.FLAG.FINALISED | fileHeader.FLAG.HAD_DROPS,
  });
  const h = fileHeader.decode(buf);
  assert.equal(buf.length, 4096);
  assert.equal(h.totalValues, 460_800_000);
  assert.equal(h.layoutName, 'BLOCK_PLANAR');
  assert.ok(h.finalised && h.hadDrops && !h.hasTrailer);
  buf[100] ^= 1;
  assert.throws(() => fileHeader.decode(buf), fileHeader.UnreadableError);
});

test('block header round-trips and detects a torn header', () => {
  const buf = Buffer.alloc(64);
  const input = { startFrameIndex: 8_000, frameCount: 1234, payloadBytes: 1234 * 128, blockIndex: 2, monotonicNanos: 99n, flags: 3, precedingGapFrames: 400, payloadCrc32c: 0xdeadbeef };
  blockHeader.encode(buf, 0, input);
  const h = blockHeader.decode(buf);
  assert.ok(h.magicOk && h.headerCrcOk);
  assert.deepEqual({ ...input, monotonicNanos: h.monotonicNanos }, { startFrameIndex: h.startFrameIndex, frameCount: h.frameCount, payloadBytes: h.payloadBytes, blockIndex: h.blockIndex, monotonicNanos: h.monotonicNanos, flags: h.flags, precedingGapFrames: h.precedingGapFrames, payloadCrc32c: h.payloadCrc32c });
  buf[20] ^= 1;
  assert.equal(blockHeader.decode(buf).headerCrcOk, false);
});

test('trailer round-trips', () => {
  const entries = [{ startFrameIndex: 48_000, frameCount: 11_400, causeCode: 2 }];
  assert.deepEqual(trailer.decode(trailer.encode(entries))?.entries, entries);
});

test('wire header round-trips', () => {
  const buf = Buffer.alloc(32);
  wire.writeHeaderNoCrc(buf, 0, { startFrameIndex: 2 ** 40, frameCount: 20, channelCount: 32, dtypeCode: 1, flags: wire.FLAG.FIRST, payloadBytes: 2560 });
  const h = wire.readHeader(buf);
  assert.equal(h.startFrameIndex, 2 ** 40);
  assert.equal(h.payloadBytes, 2560);
});
