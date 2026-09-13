// Playback re-emits exactly what was recorded, at the rate asked for, and pause and seek never lose
// position. The fixture is written straight from the format codecs, so no processes are involved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as fileHeader from '../src/format/file-header.ts';
import * as blockHeader from '../src/format/block-header.ts';
import { crc32c } from '../src/format/crc32c.ts';
import { createSignal } from '../src/signal/signal.ts';
import { openRecording } from '../src/store/recover.ts';
import { createPlayer } from '../src/playback/player.ts';

const C = 4;
const RATE = 1000;
const FRAMES_PER_BLOCK = 1000;
const BLOCKS = 2;
const TOTAL = FRAMES_PER_BLOCK * BLOCKS;

function writeFixture(): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sigacq-play-')), 'fixture.sigb');
  const stride = 64 + FRAMES_PER_BLOCK * C * 4;
  const header = fileHeader.encode({
    recordingId: Buffer.alloc(16, 1),
    channelCount: C,
    sampleRateHz: RATE,
    framesPerBlock: FRAMES_PER_BLOCK,
    blockStrideBytes: stride,
    totalFrames: TOTAL,
    totalValues: TOTAL * C,
    startTimestampUnixNanos: 0n,
    signalId: 'tri+saw+hash32/v1',
    flags: 0,
  });
  const signal = createSignal({ channelCount: C });
  const blocks = Buffer.alloc(stride * BLOCKS);
  for (let b = 0; b < BLOCKS; b++) {
    const off = b * stride;
    const payload = new Float32Array(blocks.buffer, blocks.byteOffset + off + 64, FRAMES_PER_BLOCK * C);
    signal.fillPlanar(payload, 0, b * FRAMES_PER_BLOCK, FRAMES_PER_BLOCK);
    const payloadBytes = FRAMES_PER_BLOCK * C * 4;
    blockHeader.encode(blocks, off, { startFrameIndex: b * FRAMES_PER_BLOCK, frameCount: FRAMES_PER_BLOCK, payloadBytes, blockIndex: b, monotonicNanos: 0n, flags: 0, precedingGapFrames: 0, payloadCrc32c: crc32c(blocks, off + 64, off + 64 + payloadBytes) });
  }
  fs.writeFileSync(file, Buffer.concat([header, blocks]));
  return file;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('playback emits every recorded frame, in order, with the recorded values', async () => {
  const rec = openRecording(writeFixture());
  const signal = createSignal({ channelCount: C });
  const channels = [0, 3];
  let next = 0;
  let mismatches = 0;
  await new Promise<void>((resolve) => {
    const player = createPlayer(rec, {
      channels,
      fromFrame: 0,
      toFrame: TOTAL,
      speed: 16,
      emit: (frames, start, count) => {
        assert.equal(start, next, 'frames arrive contiguously');
        for (let j = 0; j < count; j++) {
          channels.forEach((c, i) => {
            if (frames[j * channels.length + i] !== Math.fround(signal.value(c, start + j))) mismatches++;
          });
        }
        next += count;
        return true;
      },
      onEnd: () => {
        const r = player.report();
        assert.ok(Math.abs(r.deviationFrames) <= r.leadBoundFrames, `deviation ${r.deviationFrames} within one tick per segment`);
        resolve();
      },
    });
    player.play();
  });
  rec.close();
  assert.equal(next, TOTAL);
  assert.equal(mismatches, 0);
});

test('pause holds position, and seek lands on the exact frame', async () => {
  const rec = openRecording(writeFixture());
  const player = createPlayer(rec, { channels: [1], fromFrame: 0, toFrame: TOTAL, speed: 1, emit: () => true, onEnd: () => {} });
  player.play();
  await sleep(100);
  player.pause();
  const held = player.position;
  assert.ok(held > 0, 'playback advanced before the pause');
  await sleep(100);
  assert.equal(player.position, held, 'paused time is not played');

  const cost = player.seek(1500);
  assert.equal(player.position, 1500);
  assert.equal(cost.method, 'closed-form');
  assert.equal(cost.bytesRead, 64, 'a seek costs one block header');
  assert.equal(player.playing, false, 'seeking while paused stays paused');
  player.stop();
  rec.close();
});
