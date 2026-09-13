// Real-time playback: a recording re-emitted as a paced sample stream.
//
// Pacing reuses the generator's absolute-deadline scheduler, run at nativeRate × speed, so playback
// inherits the same no-drift guarantee acquisition has. Pause, resume, seek and a speed change each end
// the current pacing segment and begin a new one at the exact frame reached: position is never lost,
// and paused time is not owed. Accuracy is accumulated across segments and reported at the end.
//
// Memory is one output frame buffer sized to a tick plus the reader's per-channel block buffers — it
// scales with the channel subset and speed, never with the recording.

import { createScheduler, type Scheduler } from '../acquire/scheduler.ts';
import { makeReader } from '../store/reader.ts';
import type { Recording } from '../store/recover.ts';

export interface PlayerOptions {
  channels: number[];
  fromFrame: number;
  toFrame: number;
  speed: number;
  /** Receives interleaved float32 frames. Return false when the consumer is backed up. */
  emit: (frames: Float32Array, startFrame: number, frameCount: number) => boolean;
  onEnd: () => void;
}

export const MIN_SPEED = 0.05;
export const MAX_SPEED = 16;

export function createPlayer(rec: Recording, o: PlayerOptions) {
  const { hdr } = rec;
  const reader = makeReader(rec);
  const k = o.channels.length;
  const clampSpeed = (x: number) => Math.max(MIN_SPEED, Math.min(MAX_SPEED, x));

  let speed = clampSpeed(o.speed);
  let position = o.fromFrame;
  let scheduler: Scheduler | null = null;
  let out = new Float32Array(0);
  // leadBoundFrames: a segment emits the tick due at its own start, so it may lead by one tick; the
  // deviation is within bound when it does not exceed one tick per segment.
  const totals = { segments: 0, leadBoundFrames: 0, emittedFrames: 0, expectedFrames: 0, lateTicks: 0, resyncFrames: 0, worstP99Us: 0, maxLagUs: 0, gapFrames: 0, consumerDropFrames: 0, firstConsumerDropFrame: -1, playingSeconds: 0 };

  function emitRange(start: number, count: number): void {
    const n = Math.min(count, o.toFrame - start);
    if (n <= 0) return;
    if (out.length < n * k) out = new Float32Array(n * k);
    const frames = out.subarray(0, n * k);
    frames.fill(Number.NaN); // frames lost at acquisition stay NaN, and are counted
    let present = 0;
    for (const chunk of reader.readRange({ fromFrame: start, toFrame: start + n, channels: o.channels })) {
      const ci = o.channels.indexOf(chunk.channel);
      const base = chunk.startFrameIndex - start;
      for (let j = 0; j < chunk.frameCount; j++) frames[(base + j) * k + ci] = chunk.data[j];
      if (ci === 0) present += chunk.frameCount;
    }
    totals.gapFrames += n - present;
    // Never block on the consumer: a backed-up reader loses frames by position, the pacing does not.
    if (!o.emit(frames, start, n)) {
      if (totals.firstConsumerDropFrame < 0) totals.firstConsumerDropFrame = start;
      totals.consumerDropFrames += n;
    }
  }

  function closeSegment(): void {
    if (!scheduler) return;
    scheduler.stop();
    const r = scheduler.report();
    position = scheduler.frameIndex;
    totals.segments++;
    totals.leadBoundFrames += r.framesPerTick;
    totals.emittedFrames += r.emittedFrames;
    totals.expectedFrames += r.expectedFrames;
    totals.lateTicks += r.lateTicks;
    totals.resyncFrames += r.resyncFrames;
    totals.playingSeconds += r.elapsedSeconds;
    totals.worstP99Us = Math.max(totals.worstP99Us, r.tickLag.p99UsAtMost);
    totals.maxLagUs = Math.max(totals.maxLagUs, r.tickLag.maxUs);
    scheduler = null;
  }

  function openSegment(): void {
    const s = createScheduler({
      rateHz: hdr.sampleRateExactHz * speed,
      onFrames: (start, count) => emitRange(start, count),
      onTickEnd: () => {
        if (s.frameIndex < o.toFrame) return;
        closeSegment();
        position = o.toFrame;
        o.onEnd();
      },
    });
    scheduler = s;
    s.start(position);
  }

  return {
    get playing() {
      return scheduler !== null;
    },
    get position() {
      return scheduler ? Math.min(scheduler.frameIndex, o.toFrame) : position;
    },
    get speed() {
      return speed;
    },
    play(): void {
      if (!scheduler && position < o.toFrame) openSegment();
    },
    pause(): void {
      closeSegment();
    },
    /** Returns the measured cost of locating the target block. */
    seek(frame: number) {
      const wasPlaying = scheduler !== null;
      closeSegment();
      position = Math.max(o.fromFrame, Math.min(Math.round(frame), o.toFrame));
      const before = reader.stats.bytesRead;
      const t0 = process.hrtime.bigint();
      const hit = reader.findBlock(position);
      const cost = { microseconds: Number(process.hrtime.bigint() - t0) / 1000, bytesRead: reader.stats.bytesRead - before, method: hit?.method ?? 'past-end' };
      if (wasPlaying) openSegment();
      return cost;
    },
    setSpeed(x: number): void {
      const wasPlaying = scheduler !== null;
      closeSegment();
      speed = clampSpeed(x);
      if (wasPlaying) openSegment();
    },
    stop(): void {
      closeSegment();
    },
    /** Pacing accuracy over all playing time: emitted content frames vs elapsed × native rate × speed. */
    report() {
      const deviationFrames = totals.emittedFrames - totals.expectedFrames;
      return {
        ...totals,
        deviationFrames,
        deviationPpm: totals.expectedFrames > 0 ? (deviationFrames / totals.expectedFrames) * 1e6 : 0,
        position: this.position,
        bytesRead: reader.stats.bytesRead,
      };
    },
  };
}

export type Player = ReturnType<typeof createPlayer>;
