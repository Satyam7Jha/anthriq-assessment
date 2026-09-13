// How the trace view moves, independent of how it draws: where the visible window should start at a
// given moment, according to the latest data frame.

import type { Envelopes } from '../../types';

export const GUTTER = 44; // channel labels
export const TRACE_PAD_SECONDS = 2; // data requested beyond the visible window, split around it
const LIVE_DELAY_SECONDS = 1.1; // one committed block, plus the time to fetch it
const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

export const tickStep = (windowSeconds: number) => TICK_STEPS.find((s) => windowSeconds / s <= 10) ?? 300;

/**
 * Where the window should start at `now`, and how fast it is moving. Each frame says how fast the view
 * moves — 1× while a recording grows, the playback speed during review, 0 when paused — so the view can
 * keep moving between frames. A live recording is committed in one-second blocks, so the live view
 * trails the newest data by about a block and moves continuously rather than in steps.
 */
export function targetOf(env: Envelopes, windowSeconds: number, now: number): { start: number; velocity: number } {
  const elapsed = Math.max(0, (now - env.receivedAt) / 1000);
  const { transport } = env;
  if (transport.mode === 'live') {
    const growing = !env.finalised;
    const edge = growing ? Math.min(env.endSeconds - LIVE_DELAY_SECONDS + elapsed, env.endSeconds) : env.endSeconds;
    return { start: Math.max(0, edge - windowSeconds), velocity: growing ? 1 : 0 };
  }
  const velocity = transport.state === 'PLAYING' ? transport.rateMultiplier : 0;
  const cursor = transport.position / env.sampleRateHz + velocity * elapsed;
  return { start: Math.max(0, Math.min(cursor - windowSeconds / 2, env.endSeconds - windowSeconds)), velocity };
}
