// Playback state for the viewer: play, pause, seek, rate, live (PLAN §9.5).
//
// The cursor runs on the MONOTONIC clock (Date.now() steps under NTP). Pause, resume and seek
// re-anchor it: during playback, elapsed paused time is not owed — the one deliberate difference from
// acquisition, where it is. Position is always an exact integer frame index.

import type { OpenView } from './recording-view.ts';

export type TransportCommand =
  | { op: 'play' }
  | { op: 'pause' }
  | { op: 'rate'; multiplier: number }
  | { op: 'seek'; frame: number }
  | { op: 'mode'; mode: 'live' | 'review' };

const nowNs = () => process.hrtime.bigint();

export function createTransport() {
  const state = { playing: false, mode: 'live' as 'live' | 'review', rateMultiplier: 1, anchorFrame: 0, anchorNs: nowNs() };

  function position(v: OpenView | null): number {
    if (!v) return state.anchorFrame;
    if (!state.playing) return Math.min(state.anchorFrame, v.extent.endFrame);
    const elapsed = Number(nowNs() - state.anchorNs) / 1e9;
    return Math.max(0, Math.min(state.anchorFrame + Math.floor(elapsed * v.hdr.sampleRateExactHz * state.rateMultiplier), v.extent.endFrame));
  }

  const reanchor = (frame: number) => Object.assign(state, { anchorFrame: frame, anchorNs: nowNs() });

  function snapshot(v: OpenView | null) {
    return { state: state.playing ? 'PLAYING' : 'PAUSED', mode: state.mode, rateMultiplier: state.rateMultiplier, position: position(v) };
  }

  function apply(cmd: TransportCommand, v: OpenView) {
    switch (cmd.op) {
      case 'play':
      case 'pause':
        reanchor(position(v));
        state.playing = cmd.op === 'play';
        break;
      case 'rate':
        reanchor(position(v));
        state.rateMultiplier = Math.max(0.05, Math.min(16, Number(cmd.multiplier) || 1));
        break;
      case 'mode':
        state.mode = cmd.mode === 'review' ? 'review' : 'live';
        break;
      case 'seek': {
        // The real seek cost is measured and returned, so the viewer can show it.
        const target = Math.max(0, Math.min(Number(cmd.frame) || 0, v.extent.endFrame));
        const before = v.reader.stats.bytesRead;
        const t0 = nowNs();
        const hit = v.reader.findBlock(target);
        const microseconds = +(Number(nowNs() - t0) / 1000).toFixed(1);
        reanchor(target);
        return { ...snapshot(v), seekCost: { microseconds, bytesRead: v.reader.stats.bytesRead - before, method: hit?.method ?? 'not-found', probes: hit?.probes ?? 0 } };
      }
    }
    return snapshot(v);
  }

  /** A new recording starts live and paused. */
  function reset(): void {
    Object.assign(state, { playing: false, mode: 'live', anchorFrame: 0, anchorNs: nowNs() });
  }

  return { apply, snapshot, position, reset, get mode() { return state.mode; } };
}

export type Transport = ReturnType<typeof createTransport>;
