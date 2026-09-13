// Absolute-deadline monotonic scheduler (PLAN §6).
//
// THE INVARIANT:  emittedFrames(k) = k * framesPerTick   and   deadline(k) = t0 + k * tick.
// Neither depends on how long any tick took. Deadlines come from t0 and k, never from "now", so drift
// cannot accumulate: a late tick consumes slack, it does not move the next deadline.
//
// setInterval(fn, 5) would schedule each callback relative to the previous one's completion, compound
// ~1 ms of timer quantisation into a running sum, and lose roughly six minutes per hour.

import { DEFAULTS as D } from '../config/defaults.ts';
import { LagHistogram } from './lag-histogram.ts';

type Timer = unknown;

export interface SchedulerOptions {
  rateHz: number;
  tickNanos?: bigint;
  maxCatchupTicks?: number;
  onFrames: (startFrameIndex: number, frameCount: number) => void;
  /** Positioned pacing loss: the scheduler fell too far behind to catch up. */
  onResync?: (startFrameIndex: number, frameCount: number) => void;
  onTickEnd?: () => void;
  // Injectable for tests.
  now?: () => bigint;
  setTimeoutFn?: (fn: () => void, ms: number) => Timer;
  setImmediateFn?: (fn: () => void) => Timer;
  clearTimeoutFn?: (t: Timer) => void;
}

export function createScheduler(o: SchedulerOptions) {
  const tickNanos = o.tickNanos ?? D.TICK_NANOS;
  const maxCatchup = o.maxCatchupTicks ?? D.MAX_CATCHUP_TICKS;
  const now = o.now ?? (() => process.hrtime.bigint());
  const setTimeoutFn = o.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const setImmediateFn = o.setImmediateFn ?? ((fn) => setImmediate(fn));
  const clearTimeoutFn = o.clearTimeoutFn ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  const onResync = o.onResync ?? (() => {});
  const onTickEnd = o.onTickEnd ?? (() => {});
  const framesPerTick = Math.max(1, Math.round((o.rateHz * Number(tickNanos)) / 1e9));

  let t0 = 0n;
  let wallT0Nanos = 0n;
  let tick = 0n;
  let frameIndex = 0;
  let anchorFrame = 0;
  let running = false;
  let started = false; // explicit: an injected clock legitimately starts at zero
  let timer: Timer = null;
  const lag = new LagHistogram();
  const stats = { lateTicks: 0, resyncCount: 0, resyncFrames: 0, ticks: 0 };

  function tickOnce(): void {
    if (!running) return;
    const nowNs = now();
    // Ticks due by now, from absolute time alone. <= 0 means we woke early (on purpose): emit nothing.
    let behind = Math.max(0, Number((nowNs - t0) / tickNanos - tick) + 1);
    if (behind > 1) stats.lateTicks += behind - 1;
    const lagNs = nowNs - (t0 + tick * tickNanos);
    if (lagNs > 0n) lag.add(Number(lagNs) / 1000);

    // Catch up at most maxCatchup ticks; beyond that, skip forward and report the range as loss.
    if (behind > maxCatchup) {
      const skipFrames = (behind - maxCatchup) * framesPerTick;
      onResync(frameIndex, skipFrames);
      frameIndex += skipFrames;
      tick += BigInt(behind - maxCatchup);
      behind = maxCatchup;
      stats.resyncCount++;
      stats.resyncFrames += skipFrames;
    }
    for (let i = 0; i < behind && running; i++) {
      o.onFrames(frameIndex, framesPerTick);
      frameIndex += framesPerTick;
      tick += 1n;
      stats.ticks++;
    }
    onTickEnd();
    if (!running) return;

    // Sleep until ~1 ms before the next absolute deadline, then close the gap with setImmediate hops:
    // jitter is then bounded by one event-loop turn, not by the ~1 ms macOS timer granularity.
    // setTimeout(0) is clamped to 1 ms by libuv, so under 2 ms of slack we hop immediately.
    const sleepMs = Math.floor(Number(t0 + tick * tickNanos - now()) / 1e6 - 1);
    timer = sleepMs >= 1 ? setTimeoutFn(tickOnce, sleepMs) : setImmediateFn(tickOnce);
  }

  return {
    framesPerTick,
    tickNanos,
    get frameIndex() {
      return frameIndex;
    },
    start(startFrame = 0): void {
      if (running) return;
      t0 = now();
      wallT0Nanos = BigInt(Date.now()) * 1_000_000n;
      tick = 0n;
      frameIndex = anchorFrame = startFrame;
      running = started = true;
      timer = setImmediateFn(tickOnce);
    },
    stop(): void {
      running = false;
      if (timer) {
        clearTimeoutFn(timer);
        clearImmediate(timer as NodeJS.Immediate);
        timer = null;
      }
    },
    /** Keep position but forgive elapsed time — what resume and seek mean. Acquisition never calls it. */
    reanchor(atFrame = frameIndex): void {
      t0 = now();
      started = true;
      tick = 0n;
      frameIndex = anchorFrame = atFrame;
    },
    /** Pacing accuracy (PLAN §6.5). */
    report() {
      const elapsedNs = started ? now() - t0 : 0n;
      const emittedFrames = frameIndex - anchorFrame;
      const expectedFrames = Number((elapsedNs * BigInt(Math.round(o.rateHz))) / 1_000_000_000n);
      const deviationFrames = emittedFrames - expectedFrames;
      return {
        rateHz: o.rateHz,
        framesPerTick,
        tickNanos: Number(tickNanos),
        elapsedSeconds: Number(elapsedNs) / 1e9,
        emittedFrames,
        expectedFrames,
        deviationFrames,
        deviationPpm: expectedFrames > 0 ? +((deviationFrames / expectedFrames) * 1e6).toFixed(3) : 0,
        ...stats,
        tickLag: lag.toJSON(),
        startTimestampUnixNanos: wallT0Nanos,
        startMonotonicNanos: t0,
      };
    },
  };
}

export type Scheduler = ReturnType<typeof createScheduler>;
export type PacingReport = ReturnType<Scheduler['report']>;
