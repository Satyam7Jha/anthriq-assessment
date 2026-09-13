// Playback re-emits exactly what was recorded, at the rate asked for, and pause and seek never lose
// position.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSignal } from '../src/signal/signal.ts';
import { openRecording } from '../src/store/recover.ts';
import { createPlayer } from '../src/playback/player.ts';
import { C, TOTAL, writeFixture } from './fixture.ts';

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
