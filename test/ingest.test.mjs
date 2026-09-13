// The recorder's ingest state machine, tested without sockets, disks or timers.
//
// Every frame carries its own index as its value (exact in float32 below 2^24), so a test can check
// the one property F-01 broke: the frame index WRITTEN INTO A BLOCK HEADER is the index of the data
// in that block. A CRC cannot catch a violation of that; only a test like this can.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIngest } from '../src/acquire/ingest.js';
import { ByteRing } from '../src/ring/byte-ring.js';
import { DropLedger, CAUSE } from '../src/acquire/drop-ledger.js';

const C = 2;
const FRAMES_PER_TICK = 20;
const cfg = { framesPerBlock: 100, bytesPerFrame: C * 4 };

/** A wire block of `frameCount` frames whose every value is its own frame index. */
function block(startFrameIndex, frameCount = FRAMES_PER_TICK) {
  const buf = Buffer.alloc(frameCount * cfg.bytesPerFrame);
  for (let j = 0; j < frameCount; j++) for (let c = 0; c < C; c++) buf.writeFloatLE(startFrameIndex + j, (j * C + c) * 4);
  return { hdr: { startFrameIndex, frameCount, payloadBytes: buf.length }, buf };
}

/** A writer whose availability the test controls, recording what the file would contain. */
function fakeWriter() {
  const blocks = [];
  return {
    canAccept: true,
    blocks,
    enqueue({ interleaved, startFrameIndex, frameCount, precedingGapFrames }) {
      const values = [];
      for (let j = 0; j < frameCount; j++) values.push(interleaved.readFloatLE(j * C * 4));
      blocks.push({ startFrameIndex, frameCount, precedingGapFrames, values });
    },
  };
}

function setup({ ringFrames, maxSegments } = {}) {
  const ring = new ByteRing({ bytes: ringFrames * cfg.bytesPerFrame });
  const writer = fakeWriter();
  const ledger = new DropLedger();
  const stage = Buffer.alloc(cfg.framesPerBlock * cfg.bytesPerFrame);
  const ingest = createIngest({ cfg, ring, writer, ledger, stage, maxSegments, now: () => 0n });
  return { ring, writer, ledger, ingest };
}

/** Every block's header index must match the frame indices of the data it carries. */
function assertBlocksTruthful(blocks) {
  for (const b of blocks) {
    b.values.forEach((v, j) => {
      assert.equal(v, b.startFrameIndex + j, `block labelled ${b.startFrameIndex} holds frame ${v} at offset ${j}`);
    });
  }
}

test('contiguous input produces whole blocks with true indices', () => {
  const { writer, ingest } = setup({ ringFrames: 1000 });
  for (let f = 0; f < 400; f += FRAMES_PER_TICK) ingest.onBlock(block(f).hdr, block(f).buf, 0);
  assert.deepEqual(writer.blocks.map((b) => b.startFrameIndex), [0, 100, 200, 300]);
  assertBlocksTruthful(writer.blocks);
});

test('F-01: a RECORDER-side drop opens a positioned gap instead of shifting later indices', () => {
  // Ring holds 200 frames; the writer stalls, so the ring fills and blocks are dropped here, not
  // upstream. Before the fix, frames after the drop were labelled with indices short by the drop.
  const { writer, ledger, ingest } = setup({ ringFrames: 200 });
  writer.canAccept = false;
  for (let f = 0; f < 400; f += FRAMES_PER_TICK) {
    const b = block(f);
    ingest.onBlock(b.hdr, b.buf, 0);
  }
  assert.equal(ledger.totalDroppedFrames, 200, 'frames 200..399 did not fit and were dropped');
  assert.deepEqual(ledger.entries().map((e) => [e.startFrameIndex, e.frameCount, e.cause]), [[200, 200, 'RECORDER_RING_FULL']]);

  writer.canAccept = true;
  ingest.drain();
  for (let f = 400; f < 600; f += FRAMES_PER_TICK) {
    const b = block(f);
    ingest.onBlock(b.hdr, b.buf, 0);
  }

  assertBlocksTruthful(writer.blocks);
  assert.deepEqual(writer.blocks.map((b) => [b.startFrameIndex, b.precedingGapFrames]), [
    [0, 0],
    [100, 0],
    [400, 200], // the block after the hole says so, and says where
    [500, 0],
  ]);
});

test('a drop that frees no room still accounts for every frame, across repeated drops', () => {
  const { writer, ledger, ingest } = setup({ ringFrames: 100 });
  writer.canAccept = false;
  for (let f = 0; f < 1000; f += FRAMES_PER_TICK) {
    const b = block(f);
    ingest.onBlock(b.hdr, b.buf, 0);
  }
  writer.canAccept = true;
  ingest.drain();
  const b = block(1000);
  ingest.onBlock(b.hdr, b.buf, 0);
  while (ingest.flushOne());

  assertBlocksTruthful(writer.blocks);
  const written = writer.blocks.reduce((a, x) => a + x.frameCount, 0);
  assert.equal(written + ledger.totalDroppedFrames, 1020, 'written + dropped must equal everything offered');
  const gaps = writer.blocks.reduce((a, x) => a + x.precedingGapFrames, 0);
  assert.equal(gaps, ledger.totalDroppedFrames, 'gaps in the file must equal the ledger');
});

test('an upstream transport gap and a local drop combine into one truthful gap', () => {
  const { writer, ingest } = setup({ ringFrames: 1000 });
  for (let f = 0; f < 100; f += FRAMES_PER_TICK) ingest.onBlock(block(f).hdr, block(f).buf, 0);
  // frames 100..199 never arrive (upstream), then 200..299 arrive and are accepted
  for (let f = 200; f < 300; f += FRAMES_PER_TICK) ingest.onBlock(block(f).hdr, block(f).buf, 0);
  while (ingest.flushOne());
  assertBlocksTruthful(writer.blocks);
  assert.deepEqual(writer.blocks.map((b) => [b.startFrameIndex, b.precedingGapFrames]), [[0, 0], [200, 100]]);
});

test('the segment cap drops with accounting and keeps indices truthful', () => {
  const { writer, ledger, ingest } = setup({ ringFrames: 10_000, maxSegments: 2 });
  writer.canAccept = false;
  // Every other tick missing upstream => every accepted tick starts a new segment.
  for (let f = 0; f < 200; f += 2 * FRAMES_PER_TICK) ingest.onBlock(block(f).hdr, block(f).buf, 0);
  assert.ok(ledger.totalDroppedFrames > 0, 'cap must have been hit');
  writer.canAccept = true;
  while (ingest.flushOne());
  assertBlocksTruthful(writer.blocks);
});

test('abandonRemaining ledgers the unflushed tail by position', () => {
  const { writer, ledger, ingest } = setup({ ringFrames: 1000 });
  writer.canAccept = false;
  for (let f = 0; f < 60; f += FRAMES_PER_TICK) ingest.onBlock(block(f).hdr, block(f).buf, 0);
  ingest.abandonRemaining(CAUSE.SHUTDOWN_UNFLUSHED);
  assert.deepEqual(ledger.entries().map((e) => [e.startFrameIndex, e.frameCount, e.cause]), [[0, 60, 'SHUTDOWN_UNFLUSHED']]);
  assert.equal(ingest.segmentCount, 0);
});
