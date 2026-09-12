// Milestone 3 (PLAN §13). The deadline arithmetic is tested against an INJECTED clock, not against
// real time: a test that sleeps is slow and flaky, and the property under test is algebraic —
// "emitted frames is a pure function of the tick counter, and drift never accumulates".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../src/acquire/scheduler.js';

/** A controllable clock + timer queue. Advancing the clock is the only thing that makes time pass. */
function fakeEnv() {
  let nowNs = 0n;
  let queue = [];
  return {
    now: () => nowNs,
    // libuv clamps setTimeout(0) to 1 ms; model that rather than letting a zero-delay timer fire
    // at the same instant forever.
    setTimeoutFn: (fn, ms) => {
      const at = nowNs + BigInt(Math.max(1, Math.floor(ms))) * 1_000_000n;
      const h = { fn, at };
      queue.push(h);
      return h;
    },
    // An event-loop turn is not free. Charging it ~50 us is what makes the fake clock model the
    // scheduler's setImmediate spin-to-deadline honestly — with a zero-cost setImmediate the spin
    // would never terminate.
    setImmediateFn: (fn) => {
      const h = { fn, at: nowNs + 50_000n };
      queue.push(h);
      return h;
    },
    clearTimeoutFn: (h) => {
      queue = queue.filter((x) => x !== h);
    },
    /** Run every callback whose deadline has passed, then jump the clock to `toNs`. */
    advanceTo(toNs) {
      let guard = 0;
      for (;;) {
        queue.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
        const next = queue[0];
        if (!next || next.at > toNs) break;
        queue.shift();
        if (next.at > nowNs) nowNs = next.at;
        next.fn();
        if (++guard > 2_000_000) throw new Error('timer storm');
      }
      if (toNs > nowNs) nowNs = toNs;
    },
    /** Freeze the clock and drain the queue — simulates a stall where no wall time passes. */
    jump(ns) {
      nowNs += BigInt(ns);
    },
  };
}

test('emits exactly rate*seconds frames over 10 simulated seconds', () => {
  const env = fakeEnv();
  let frames = 0;
  const s = createScheduler({ rateHz: 4000, onFrames: (_i, n) => (frames += n), ...env });
  s.start();
  env.advanceTo(10_000_000_000n);
  s.stop();
  // The scheduler emits the tick whose absolute deadline has ARRIVED, so at an exact second
  // boundary it is legitimately one tick ahead. The graded property is that it is never BEHIND and
  // never accumulates: the count must land in [rate*seconds, rate*seconds + framesPerTick].
  assert.ok(
    frames >= 40_000 && frames <= 40_000 + s.framesPerTick,
    `expected 40,000..40,020 frames in 10 s at 4 kHz, got ${frames}`
  );
  const dev = s.report().deviationFrames;
  assert.ok(dev >= 0 && dev <= s.framesPerTick, `deviation ${dev} frames outside [0, 20]`);
});

test('frameIndex is contiguous — no gaps, no overlaps', () => {
  const env = fakeEnv();
  let expectNext = 0;
  const s = createScheduler({
    rateHz: 4000,
    onFrames: (start, n) => {
      assert.equal(start, expectNext, `discontinuity: expected ${expectNext}, got ${start}`);
      expectNext = start + n;
    },
    ...env,
  });
  s.start();
  env.advanceTo(3_000_000_000n);
  s.stop();
  assert.ok(expectNext >= 12_000 && expectNext <= 12_020, `ended at frame ${expectNext}`);
});

test('a long tick does NOT shift the schedule (this is the anti-drift property)', () => {
  const env = fakeEnv();
  let frames = 0;
  const s = createScheduler({
    rateHz: 4000,
    // Every tick burns 4 ms of the 5 ms budget. With setInterval semantics this would compound into
    // ~80% drift; with absolute deadlines it must produce exactly zero.
    onFrames: (_i, n) => {
      frames += n;
      env.jump(4_000_000);
    },
    ...env,
  });
  s.start();
  env.advanceTo(5_000_000_000n);
  s.stop();
  assert.ok(
    frames >= 20_000 && frames <= 20_000 + s.framesPerTick,
    `drift detected: got ${frames}, expected 20,000..20,020`
  );
});

test('catch-up: a 100 ms stall is absorbed, with no frames lost and no resync', () => {
  const env = fakeEnv();
  let frames = 0;
  let resyncs = 0;
  const s = createScheduler({
    rateHz: 4000,
    onFrames: (_i, n) => (frames += n),
    onResync: () => resyncs++,
    ...env,
  });
  s.start();
  env.advanceTo(1_000_000_000n);
  env.jump(100_000_000); // 100 ms = 20 ticks, inside the 40-tick catch-up budget
  env.advanceTo(2_000_000_000n);
  s.stop();
  assert.equal(resyncs, 0, 'a 100 ms stall must be caught up, not resynced');
  assert.ok(frames >= 8_000 && frames <= 8_020, `expected 8,000..8,020 frames for 2 s, got ${frames}`);
});

test('resync: a 5 s stall exceeds the budget and reports POSITIONED loss, not silent drift', () => {
  const env = fakeEnv();
  let frames = 0;
  const resyncs = [];
  const s = createScheduler({
    rateHz: 4000,
    onFrames: (_i, n) => (frames += n),
    onResync: (start, count) => resyncs.push({ start, count }),
    ...env,
  });
  s.start();
  env.advanceTo(1_000_000_000n);
  const posAtStall = s.frameIndex; // the tick due at exactly t=1.000 s has already fired
  env.jump(5_000_000_000); // 5 s = 1,000 ticks, far past the 40-tick budget
  env.advanceTo(7_000_000_000n);
  s.stop();

  assert.equal(resyncs.length, 1, 'exactly one resync event expected');
  // The gap starts exactly where emission stopped — that is the POSITION the assessment requires.
  assert.equal(resyncs[0].start, posAtStall);
  // 1,000 ticks due, 40 absorbed => 960 skipped => 19,200 frames at 20 frames/tick.
  assert.equal(resyncs[0].count, 19_200);
  // The skipped frames are ACCOUNTED FOR, not silently missing. Everything emitted plus everything
  // reported as skipped equals the wall-clock expectation, to within the one tick the scheduler is
  // legitimately AHEAD by: it emits the tick whose absolute deadline has arrived, so the count is
  // always in [expected, expected + framesPerTick). Being at most one tick early and never late is
  // the property that matters; this is what makes the loss auditable rather than indistinguishable
  // from drift.
  const total = frames + resyncs[0].count;
  assert.ok(
    total >= 7 * 4000 && total <= 7 * 4000 + s.framesPerTick,
    `emitted+skipped ${total} outside [28000, 28020]`
  );
  assert.equal(s.report().resyncFrames, 19_200);
  const dev = s.report().deviationFrames;
  assert.ok(dev >= 0 && dev <= s.framesPerTick, `deviation ${dev} outside [0, 20] after resync`);
});

test('framesPerTick is derived from the rate, for several rates', () => {
  const mk = (rateHz) => createScheduler({ rateHz, onFrames: () => {}, ...fakeEnv() }).framesPerTick;
  assert.equal(mk(4000), 20); // default
  assert.equal(mk(1000), 5); // 0.25x playback
  assert.equal(mk(32000), 160); // 8x playback
  assert.equal(mk(250), 1); // clinical EEG rate
  assert.equal(mk(60), 1); // clamped to at least one frame per tick
});

test('reanchor keeps position but forgives elapsed time (the pause/resume property)', () => {
  const env = fakeEnv();
  let frames = 0;
  const resyncs = [];
  const s = createScheduler({
    rateHz: 4000,
    onFrames: (_i, n) => (frames += n),
    onResync: (start, count) => resyncs.push({ start, count }),
    ...env,
  });
  s.start();
  env.advanceTo(1_000_000_000n);
  const posBefore = s.frameIndex;
  s.stop(); // "pause"
  env.jump(30_000_000_000); // 30 s paused
  s.reanchor(posBefore); // "resume" — elapsed time is not owed
  frames = 0;
  s.start(posBefore);
  s.reanchor(posBefore);
  env.advanceTo(31_500_000_000n);
  s.stop();

  assert.equal(resyncs.length, 0, 'resume must not try to catch up the pause duration');
  assert.equal(s.frameIndex, posBefore + frames, 'position must continue from where it paused');
});
