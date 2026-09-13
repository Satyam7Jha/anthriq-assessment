// The deadline arithmetic, tested against an injected clock rather than real time: the property is
// algebraic — emitted frames are a function of the tick counter, and drift never accumulates.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../src/acquire/scheduler.ts';

interface Pending {
  fn: () => void;
  at: bigint;
}

/** A controllable clock and timer queue. Only advancing the clock makes time pass. */
function fakeEnv() {
  let nowNs = 0n;
  let queue: Pending[] = [];
  const push = (fn: () => void, at: bigint) => {
    const h = { fn, at };
    queue.push(h);
    return h;
  };
  return {
    now: () => nowNs,
    // libuv clamps setTimeout(0) to 1 ms.
    setTimeoutFn: (fn: () => void, ms: number) => push(fn, nowNs + BigInt(Math.max(1, Math.floor(ms))) * 1_000_000n),
    // An event-loop turn is not free; with a zero-cost setImmediate the spin-to-deadline never ends.
    setImmediateFn: (fn: () => void) => push(fn, nowNs + 50_000n),
    clearTimeoutFn: (h: unknown) => void (queue = queue.filter((x) => x !== h)),
    advanceTo(toNs: bigint) {
      for (let guard = 0; ; guard++) {
        queue.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
        const next = queue[0];
        if (!next || next.at > toNs) break;
        queue.shift();
        if (next.at > nowNs) nowNs = next.at;
        next.fn();
        if (guard > 2_000_000) throw new Error('timer storm');
      }
      if (toNs > nowNs) nowNs = toNs;
    },
    /** A stall: wall time passes with nothing running. */
    jump: (ns: number) => void (nowNs += BigInt(ns)),
  };
}

// The scheduler emits the tick whose deadline has ARRIVED, so at an exact boundary it is legitimately
// one tick ahead. The graded property: never behind, never accumulating.
const within = (got: number, expected: number, tick = 20) => got >= expected && got <= expected + tick;

test('emits rate x seconds frames over 10 simulated seconds', () => {
  const env = fakeEnv();
  let frames = 0;
  const s = createScheduler({ rateHz: 4000, onFrames: (_i, n) => (frames += n), ...env });
  s.start();
  env.advanceTo(10_000_000_000n);
  s.stop();
  assert.ok(within(frames, 40_000), `got ${frames}`);
  assert.ok(within(s.report().deviationFrames, 0));
});

test('frame indices are contiguous', () => {
  const env = fakeEnv();
  let expectNext = 0;
  const s = createScheduler({
    rateHz: 4000,
    onFrames: (start, n) => {
      assert.equal(start, expectNext);
      expectNext = start + n;
    },
    ...env,
  });
  s.start();
  env.advanceTo(3_000_000_000n);
  s.stop();
  assert.ok(within(expectNext, 12_000));
});

test('a long tick does not shift the schedule (anti-drift)', () => {
  const env = fakeEnv();
  let frames = 0;
  // Each tick burns 4 of its 5 ms. setInterval would compound that; absolute deadlines must not.
  const s = createScheduler({ rateHz: 4000, onFrames: (_i, n) => ((frames += n), env.jump(4_000_000)), ...env });
  s.start();
  env.advanceTo(5_000_000_000n);
  s.stop();
  assert.ok(within(frames, 20_000), `drift: got ${frames}`);
});

test('a 100 ms stall is caught up with no loss', () => {
  const env = fakeEnv();
  let frames = 0;
  let resyncs = 0;
  const s = createScheduler({ rateHz: 4000, onFrames: (_i, n) => (frames += n), onResync: () => resyncs++, ...env });
  s.start();
  env.advanceTo(1_000_000_000n);
  env.jump(100_000_000);
  env.advanceTo(2_000_000_000n);
  s.stop();
  assert.equal(resyncs, 0);
  assert.ok(within(frames, 8_000));
});

test('a 5 s stall resyncs and reports positioned loss, not silent drift', () => {
  const env = fakeEnv();
  let frames = 0;
  const resyncs: { start: number; count: number }[] = [];
  const s = createScheduler({ rateHz: 4000, onFrames: (_i, n) => (frames += n), onResync: (start, count) => resyncs.push({ start, count }), ...env });
  s.start();
  env.advanceTo(1_000_000_000n);
  const posAtStall = s.frameIndex;
  env.jump(5_000_000_000); // 1,000 ticks, far past the 40-tick catch-up budget
  env.advanceTo(7_000_000_000n);
  s.stop();
  assert.equal(resyncs.length, 1);
  assert.equal(resyncs[0].start, posAtStall); // the gap starts exactly where emission stopped
  assert.equal(resyncs[0].count, 19_200); // 960 skipped ticks x 20 frames
  assert.ok(within(frames + resyncs[0].count, 28_000), 'emitted + skipped must equal wall-clock time');
});

test('framesPerTick follows the rate', () => {
  const tick = (rateHz: number) => createScheduler({ rateHz, onFrames: () => {}, ...fakeEnv() }).framesPerTick;
  assert.deepEqual([4000, 1000, 32000, 250, 60].map(tick), [20, 5, 160, 1, 1]);
});

test('reanchor keeps position but forgives elapsed time', () => {
  const env = fakeEnv();
  let frames = 0;
  let resyncs = 0;
  const s = createScheduler({ rateHz: 4000, onFrames: (_i, n) => (frames += n), onResync: () => resyncs++, ...env });
  s.start();
  env.advanceTo(1_000_000_000n);
  const pos = s.frameIndex;
  s.stop();
  env.jump(30_000_000_000); // paused for 30 s
  frames = 0;
  s.start(pos);
  s.reanchor(pos);
  env.advanceTo(31_500_000_000n);
  s.stop();
  assert.equal(resyncs, 0, 'resume must not try to catch up the pause');
  assert.equal(s.frameIndex, pos + frames);
});
