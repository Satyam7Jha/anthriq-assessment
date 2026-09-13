'use strict';
// Absolute-deadline monotonic scheduler. PLAN §6.
//
// THE INVARIANT, enforced every tick:
//   emittedFrames(k) = k * FRAMES_PER_TICK          — a pure function of the tick counter
//   deadline(k)      = t0 + k * TICK_NS             — a pure function of the run's start instant
// Neither depends on how long any tick took. Because deadline(k) is computed from t0 and k and
// NEVER from "now", drift cannot accumulate by construction: a tick that runs 3 ms late does not
// move the next deadline, it merely leaves less slack. The error is bounded jitter, not a random
// walk.
//
// Why not setInterval(fn, 5): it schedules the next callback relative to the COMPLETION of the
// previous one, after libuv has rounded the timeout up to the next loop iteration. Three error
// sources compound — ~1 ms timer quantisation on macOS, accumulation (each late callback shifts the
// next deadline later, a running sum rather than bounded jitter), and coupling to work. At a
// pessimistic +0.5 ms/tick over 200 ticks/s that is +100 ms of drift per second: six minutes per
// hour, a ~10% sample shortfall. Not a subtle effect — a total failure of the primary requirement.
//
// Used by the generator. It is parameterised by rate rather than hard-wired to acquisition, and
// reanchor() exists for pause/resume/seek, but the viewer's review cursor does not run on it: the
// viewer only needs the right position twenty times a second, which it derives from the monotonic
// clock directly (bin/uiserver.js).

const D = require('../config/defaults');

/** O(1)-memory log-ish histogram of tick lag, in microseconds. Fixed 64 buckets, never grows. */
class LagHistogram {
  constructor() {
    this.buckets = new Float64Array(64); // bucket i covers [2^i, 2^(i+1)) microseconds
    this.n = 0;
    this.maxUs = 0;
    this.sumUs = 0;
  }
  add(us) {
    this.n++;
    this.sumUs += us;
    if (us > this.maxUs) this.maxUs = us;
    const v = us < 1 ? 0 : Math.min(63, 31 - Math.clz32(Math.floor(us)) + 1);
    this.buckets[v]++;
  }
  /** Upper bound of the bucket containing the qth quantile — reported as "<= X us", honestly. */
  quantile(q) {
    const target = this.n * q;
    let acc = 0;
    for (let i = 0; i < 64; i++) {
      acc += this.buckets[i];
      if (acc >= target) return i === 0 ? 1 : 2 ** i;
    }
    return this.maxUs;
  }
  toJSON() {
    return {
      samples: this.n,
      meanUs: this.n ? +(this.sumUs / this.n).toFixed(1) : 0,
      p50UsAtMost: this.quantile(0.5),
      p99UsAtMost: this.quantile(0.99),
      maxUs: +this.maxUs.toFixed(1),
    };
  }
}

/**
 * @param {object} opts
 * @param {number} opts.rateHz            effective frames per second
 * @param {bigint} [opts.tickNanos]       tick period
 * @param {number} [opts.maxCatchupTicks] ticks of backlog to absorb before declaring bankruptcy
 * @param {(startFrameIndex:number, frameCount:number)=>void} opts.onFrames
 * @param {(startFrameIndex:number, frameCount:number)=>void} [opts.onResync] positioned pacing loss
 * @param {()=>bigint} [opts.now]         injectable clock, for tests
 * @param {(fn:Function, ms:number)=>any} [opts.setTimeoutFn]
 * @param {(fn:Function)=>any} [opts.setImmediateFn]
 */
function createScheduler(opts) {
  const {
    rateHz,
    tickNanos = D.TICK_NANOS,
    maxCatchupTicks = D.MAX_CATCHUP_TICKS,
    onFrames,
    onResync = () => {},
    onTickEnd = () => {},
    now = () => process.hrtime.bigint(),
    setTimeoutFn = setTimeout,
    setImmediateFn = setImmediate,
    clearTimeoutFn = clearTimeout,
  } = opts;

  const tickSeconds = Number(tickNanos) / 1e9;
  const framesPerTick = Math.max(1, Math.round(rateHz * tickSeconds));

  let t0 = 0n;
  let wallT0Nanos = 0n;
  let tick = 0n; // ticks fully emitted
  let frameIndex = 0; // next frame to emit
  let anchorFrame = 0; // frameIndex at the current clock anchor (non-zero after a seek)
  let running = false;
  let started = false; // explicit, rather than inferring from t0 !== 0n: an injected test clock
                       // legitimately starts at zero, and so could a monotonic clock at boot.
  let timer = null;
  const lag = new LagHistogram();
  const stats = { lateTicks: 0, resyncCount: 0, resyncFrames: 0, ticks: 0 };

  function tickOnce() {
    if (!running) return;
    const nowNs = now();

    // How many ticks SHOULD have fired by now, from absolute time alone.
    const due = (nowNs - t0) / tickNanos; // BigInt floor division
    let behind = Number(due - tick) + 1; // +1: the current tick is itself due
    // behind <= 0 means we woke BEFORE the next deadline. That is the normal case, not an error:
    // the timer below deliberately wakes ~1 ms early and then hops on setImmediate. Emitting here
    // would run the stream fast, so we emit nothing and re-arm. This is the difference between
    // "pace to a deadline" and "emit whenever we happen to wake".
    if (behind < 0) behind = 0;
    if (behind > 1) stats.lateTicks += behind - 1;

    const lagNs = nowNs - (t0 + tick * tickNanos);
    if (lagNs > 0n) lag.add(Number(lagNs) / 1000);

    // CATCH-UP POLICY. Emitting thirty minutes of backlog after a laptop-lid stall would blow every
    // buffer downstream and is meaningless for a real-time instrument. Absorb up to
    // maxCatchupTicks, then declare bankruptcy and RESYNCHRONISE — recording the skipped range as a
    // real, positioned loss rather than pretending it never happened.
    if (behind > maxCatchupTicks) {
      const skipTicks = behind - maxCatchupTicks;
      const skipFrames = skipTicks * framesPerTick;
      onResync(frameIndex, skipFrames);
      frameIndex += skipFrames;
      tick += BigInt(skipTicks);
      behind = maxCatchupTicks;
      stats.resyncCount++;
      stats.resyncFrames += skipFrames;
    }

    for (let i = 0; i < behind && running; i++) {
      onFrames(frameIndex, framesPerTick);
      frameIndex += framesPerTick;
      tick += 1n;
      stats.ticks++;
    }

    onTickEnd();
    if (!running) return;

    // Schedule the NEXT tick against its ABSOLUTE deadline.
    const nextDeadline = t0 + tick * tickNanos;
    const sleepMs = Number(nextDeadline - now()) / 1e6;
    // Ask for one whole millisecond LESS than the remaining slack, and only if that is still at
    // least 1 ms. setTimeout(0) is not a short sleep — libuv clamps it to 1 ms and it would put us
    // right back here, so anything under 2 ms of slack goes straight to the setImmediate hop.
    const sleepTargetMs = Math.floor(sleepMs - 1);
    if (sleepTargetMs >= 1) {
      // Deliberately wake ~1 ms EARLY: macOS timer granularity is ~1 ms and occasionally worse under
      // power management, so we burn the last <=1.5 ms in setImmediate hops. Tick jitter is then
      // bounded by one event-loop turn rather than by timer granularity. At 200 ticks/s with a
      // ~1 ms/s workload the loop is idle >99% of the time, so there is ample room for this.
      timer = setTimeoutFn(tickOnce, sleepTargetMs);
    } else {
      timer = setImmediateFn(tickOnce);
    }
  }

  return {
    framesPerTick,
    tickNanos,
    get frameIndex() {
      return frameIndex;
    },
    get running() {
      return running;
    },

    start(startFrame = 0) {
      if (running) return;
      t0 = now();
      wallT0Nanos = BigInt(Date.now()) * 1_000_000n;
      tick = 0n;
      frameIndex = startFrame;
      anchorFrame = startFrame;
      running = true;
      started = true;
      timer = setImmediateFn(tickOnce);
    },

    stop() {
      running = false;
      if (timer) {
        clearTimeoutFn(timer);
        if (typeof clearImmediate === 'function') clearImmediate(timer);
        timer = null;
      }
    },

    /**
     * Re-anchor the clock to now, keeping the current frame position. This is the deliberate
     * difference between playback and acquisition (PLAN §9.5): after a pause or a seek, the elapsed
     * wall time is NOT owed, so without re-anchoring the absolute-deadline scheme would compute a
     * huge `behind` and try to emit the whole pause as catch-up. During acquisition it IS owed,
     * which is why the generator never calls this.
     */
    reanchor(atFrame = frameIndex) {
      t0 = now();
      started = true;
      tick = 0n;
      frameIndex = atFrame;
      anchorFrame = atFrame;
    },

    /** Pacing accuracy, PLAN §6.5. */
    report() {
      const elapsedNs = started ? now() - t0 : 0n;
      const emittedFrames = frameIndex - anchorFrame;
      // Exact BigInt ratio, floored — no float rounding in the identity the claim rests on.
      const expectedFrames = Number((elapsedNs * BigInt(Math.round(rateHz))) / 1_000_000_000n);
      const deviationFrames = emittedFrames - expectedFrames;
      return {
        rateHz,
        framesPerTick,
        tickNanos: Number(tickNanos),
        elapsedSeconds: Number(elapsedNs) / 1e9,
        emittedFrames,
        expectedFrames,
        deviationFrames,
        deviationNanos: (deviationFrames * 1e9) / rateHz,
        deviationPpm: expectedFrames > 0 ? +((deviationFrames / expectedFrames) * 1e6).toFixed(3) : 0,
        lateTicks: stats.lateTicks,
        ticks: stats.ticks,
        resyncCount: stats.resyncCount,
        resyncFrames: stats.resyncFrames,
        tickLag: lag.toJSON(),
        startTimestampUnixNanos: wallT0Nanos,
        startMonotonicNanos: t0,
      };
    },
  };
}

module.exports = { createScheduler, LagHistogram };
