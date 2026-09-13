// The recorder's ingest state machine, without sockets, disks or timers.
//
// Every frame carries its own index as its value (exact in float32 below 2^24), so these tests check
// the property F-01 broke: the frame index written into a block header is the index of the data in
// that block. A CRC cannot catch a violation of that.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIngest } from '../src/acquire/ingest.ts';
import { ByteRing } from '../src/ring/byte-ring.ts';
import { DropLedger, CAUSE } from '../src/acquire/drop-ledger.ts';

const C = 2;
const TICK = 20;
const framesPerBlock = 100;
const bytesPerFrame = C * 4;

interface Written {
  startFrameIndex: number;
  frameCount: number;
  precedingGapFrames: number;
  values: number[];
}

function block(startFrameIndex: number, frameCount = TICK) {
  const buf = Buffer.alloc(frameCount * bytesPerFrame);
  for (let j = 0; j < frameCount; j++) for (let c = 0; c < C; c++) buf.writeFloatLE(startFrameIndex + j, (j * C + c) * 4);
  return { hdr: { startFrameIndex, frameCount, payloadBytes: buf.length }, buf };
}

function setup(ringFrames: number, maxSegments?: number) {
  const blocks: Written[] = [];
  const writer = {
    canAccept: true,
    enqueue(b: { interleaved: Buffer; startFrameIndex: number; frameCount: number; precedingGapFrames: number }) {
      const values = Array.from({ length: b.frameCount }, (_, j) => b.interleaved.readFloatLE(j * C * 4));
      blocks.push({ startFrameIndex: b.startFrameIndex, frameCount: b.frameCount, precedingGapFrames: b.precedingGapFrames, values });
    },
  };
  const ledger = new DropLedger();
  const ingest = createIngest({
    framesPerBlock,
    bytesPerFrame,
    ring: new ByteRing(ringFrames * bytesPerFrame),
    writer,
    ledger,
    stage: Buffer.alloc(framesPerBlock * bytesPerFrame),
    now: () => 0n,
    maxSegments,
  });
  const offer = (from: number, to: number, step = TICK) => {
    for (let f = from; f < to; f += step) {
      const b = block(f);
      ingest.onBlock(b.hdr, b.buf, 0);
    }
  };
  return { blocks, writer, ledger, ingest, offer };
}

/** The header's frame index must be the index of the data the block holds. */
function assertTruthful(blocks: Written[]) {
  for (const b of blocks) b.values.forEach((v, j) => assert.equal(v, b.startFrameIndex + j, `block ${b.startFrameIndex} holds frame ${v} at offset ${j}`));
}

test('contiguous input produces whole blocks with true indices', () => {
  const { blocks, offer } = setup(1000);
  offer(0, 400);
  assert.deepEqual(blocks.map((b) => b.startFrameIndex), [0, 100, 200, 300]);
  assertTruthful(blocks);
});

test('F-01: a recorder-side drop opens a positioned gap instead of shifting later indices', () => {
  const { blocks, writer, ledger, ingest, offer } = setup(200);
  writer.canAccept = false; // the disk stalls, so the ring fills and blocks are dropped HERE
  offer(0, 400);
  assert.deepEqual(ledger.entries().map((e) => [e.startFrameIndex, e.frameCount, e.cause]), [[200, 200, 'RECORDER_RING_FULL']]);
  writer.canAccept = true;
  ingest.drain();
  offer(400, 600);
  assertTruthful(blocks);
  assert.deepEqual(blocks.map((b) => [b.startFrameIndex, b.precedingGapFrames]), [[0, 0], [100, 0], [400, 200], [500, 0]]);
});

test('repeated drops: every offered frame is either written or ledgered', () => {
  const { blocks, writer, ledger, ingest, offer } = setup(100);
  writer.canAccept = false;
  offer(0, 1000);
  writer.canAccept = true;
  ingest.drain();
  offer(1000, 1020);
  while (ingest.flushOne());
  assertTruthful(blocks);
  const written = blocks.reduce((a, b) => a + b.frameCount, 0);
  assert.equal(written + ledger.totalDroppedFrames, 1020);
  assert.equal(blocks.reduce((a, b) => a + b.precedingGapFrames, 0), ledger.totalDroppedFrames);
});

test('an upstream transport gap becomes one truthful gap', () => {
  const { blocks, ingest, offer } = setup(1000);
  offer(0, 100);
  offer(200, 300);
  while (ingest.flushOne());
  assertTruthful(blocks);
  assert.deepEqual(blocks.map((b) => [b.startFrameIndex, b.precedingGapFrames]), [[0, 0], [200, 100]]);
});

test('the segment cap drops with accounting and keeps indices truthful', () => {
  const { blocks, writer, ledger, ingest, offer } = setup(10_000, 2);
  writer.canAccept = false;
  offer(0, 200, TICK * 2); // every other tick missing, so every accepted tick opens a segment
  assert.ok(ledger.totalDroppedFrames > 0);
  writer.canAccept = true;
  while (ingest.flushOne());
  assertTruthful(blocks);
});

test('abandonRemaining ledgers the unflushed tail by position', () => {
  const { writer, ledger, ingest, offer } = setup(1000);
  writer.canAccept = false;
  offer(0, 60);
  ingest.abandonRemaining(CAUSE.SHUTDOWN_UNFLUSHED);
  assert.deepEqual(ledger.entries().map((e) => [e.startFrameIndex, e.frameCount, e.cause]), [[0, 60, 'SHUTDOWN_UNFLUSHED']]);
  assert.equal(ingest.segmentCount, 0);
});
