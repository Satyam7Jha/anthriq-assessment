import { useEffect, useRef } from 'react';
import type { Envelopes, Marker } from '../types';
import { channelLabel } from '../lib';

/**
 * The canonical multi-channel ExG view: STACKED per-channel traces on a shared time axis.
 *
 * Why stacked and not one overlaid multi-series chart — the thing a generic charting library would
 * give you. A reviewer's task is per-channel: *which electrode shows the artefact*. Overlaying 32
 * traces makes per-channel morphology unreadable, which is why every EEG review tool in existence
 * stacks them. Building the overlaid version here would be the tell that nobody looked at how this
 * data is actually read.
 *
 * PERFORMANCE ARCHITECTURE (PLAN §11.4) — the reason this is a ref-driven canvas and not JSX:
 *   - React owns chrome and state ONLY. It never touches pixel data.
 *   - The canvas is an uncontrolled ref; drawing happens in a requestAnimationFrame loop that reads
 *     from a mutable ref the SSE handler writes to.
 *   - ZERO React re-renders per frame. A setState at 20 Hz carrying 64 KB of floats would reconcile
 *     32 components 20 times a second for no benefit whatsoever.
 *   - Each channel is one Path2D of vertical segments, so 32 channels x 1,000 columns is 32 fill
 *     operations, not 32,000 DOM or draw calls.
 */

export interface TraceStackProps {
  envelopesRef: React.RefObject<Envelopes>;
  channels: number[];
  gains: Record<number, number>;
  offsets: Record<number, number>;
  rowHeight: number;
  amplitudeScale: number;
  channelCount: number;
  useMontage: boolean;
  markers: Marker[];
  windowFromSeconds: number;
  windowSecondsRef: React.RefObject<number>;
  onFps?: (fps: number, frameMs: number) => void;
}

const GUTTER = 64; // left label column, fixed — labels must not scroll with the data

export function TraceStack(props: TraceStackProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Every prop the draw loop reads goes through a ref. If the loop read props directly it would
  // capture stale values, and adding them to a dependency array would restart the rAF loop on every
  // keystroke — both of which are the usual ways a canvas in React ends up janky.
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    let raf = 0;
    let lastFpsReport = performance.now();
    let frames = 0;
    let frameMsAccum = 0;

    const draw = () => {
      const t0 = performance.now();
      const p = propsRef.current;
      const dpr = Math.min(window.devicePixelRatio || 1, 2); // cap at 2: 3x costs 2.25x the fill for no visible gain
      const cssW = canvas.clientWidth;
      const cssH = Math.max(1, p.channels.length * p.rowHeight);
      if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
        canvas.width = Math.floor(cssW * dpr);
        canvas.height = Math.floor(cssH * dpr);
        canvas.style.height = `${cssH}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      ctx.fillStyle = '#020617'; // slate-950
      ctx.fillRect(0, 0, cssW, cssH);

      const plotW = Math.max(1, cssW - GUTTER);
      const envelopes = p.envelopesRef.current;
      const windowSeconds = p.windowSecondsRef.current;

      // --- gap bands, drawn UNDER the traces and across every row -----------------------------
      // R18 rendered literally. "Dropped: 38,400" is a number; a red band at 35:03 spanning all 32
      // rows is an answer to "where".
      for (const m of p.markers) {
        const x0 = ((m.onsetSeconds - p.windowFromSeconds) / windowSeconds) * plotW + GUTTER;
        const x1 = ((m.onsetSeconds + m.durationSeconds - p.windowFromSeconds) / windowSeconds) * plotW + GUTTER;
        if (x1 < GUTTER || x0 > cssW) continue;
        const left = Math.max(GUTTER, x0);
        const width = Math.max(1.5, Math.min(cssW, x1) - left);
        ctx.fillStyle = m.kind === 'RESYNC' ? 'rgba(168,85,247,0.22)' : 'rgba(239,68,68,0.22)';
        ctx.fillRect(left, 0, width, cssH);
        ctx.fillStyle = m.kind === 'RESYNC' ? 'rgba(168,85,247,0.9)' : 'rgba(239,68,68,0.9)';
        ctx.fillRect(left, 0, 1.5, cssH);
      }

      // --- one Path2D of vertical segments per channel ------------------------------------------
      for (let row = 0; row < p.channels.length; row++) {
        const channel = p.channels[row]!;
        const yTop = row * p.rowHeight;
        const yMid = yTop + p.rowHeight / 2;
        const halfRow = p.rowHeight / 2 - 2;

        // row separator + baseline
        ctx.fillStyle = 'rgba(148,163,184,0.10)';
        ctx.fillRect(GUTTER, yTop, plotW, 1);
        ctx.fillStyle = 'rgba(148,163,184,0.16)';
        ctx.fillRect(GUTTER, Math.round(yMid), plotW, 1);

        const env = envelopes.get(channel);
        if (env && env.length >= 2) {
          const columns = env.length / 2;
          const gain = p.gains[channel] ?? 1;
          const offset = p.offsets[channel] ?? 0;
          const scale = (halfRow / p.amplitudeScale) * gain;
          const colW = plotW / columns;

          const path = new Path2D();
          let clipped = false;
          for (let c = 0; c < columns; c++) {
            const lo = env[c * 2]!;
            const hi = env[c * 2 + 1]!;
            let yHi = yMid - (hi + offset) * scale;
            let yLo = yMid - (lo + offset) * scale;
            // CLIP at the row boundary and flag it. Letting a channel overdraw its neighbours is the
            // single most misleading failure mode in a stacked view — it silently attributes one
            // electrode's artefact to another.
            if (yHi < yTop + 1) {
              yHi = yTop + 1;
              clipped = true;
            }
            if (yLo > yTop + p.rowHeight - 1) {
              yLo = yTop + p.rowHeight - 1;
              clipped = true;
            }
            const x = GUTTER + c * colW;
            // A single-sample spike still extends the column's extent — min/max decimation never
            // hides a transient (PLAN §11.2).
            path.rect(x, yHi, Math.max(0.7, colW * 0.9), Math.max(0.7, yLo - yHi));
          }
          ctx.fillStyle = clipped ? 'rgb(251,191,36)' : 'rgb(103,232,249)';
          ctx.fill(path);

          if (clipped) {
            ctx.fillStyle = 'rgba(251,191,36,0.75)';
            ctx.fillRect(GUTTER, yTop, 2, p.rowHeight); // tint the row edge, do not hide the clip
          }
        } else {
          ctx.fillStyle = 'rgba(148,163,184,0.35)';
          ctx.font = '11px ui-monospace, monospace';
          ctx.fillText('no data in window', GUTTER + 10, yMid + 4);
        }

        // --- fixed left gutter: label + per-row scale bar ---
        ctx.fillStyle = '#020617';
        ctx.fillRect(0, yTop, GUTTER, p.rowHeight);
        ctx.fillStyle = 'rgba(226,232,240,0.85)';
        ctx.font = '11px ui-monospace, SFMono-Regular, monospace';
        ctx.fillText(channelLabel(channel, p.useMontage, p.channelCount), 8, yMid + 4);
        // Scale bar: the minimum ink that makes amplitude readable. Gridlines at this trace density
        // would compete with the signal.
        if (p.rowHeight >= 28) {
          ctx.fillStyle = 'rgba(148,163,184,0.45)';
          ctx.fillRect(GUTTER - 8, yMid - halfRow / 2, 1, halfRow);
        }
      }

      ctx.fillStyle = 'rgba(148,163,184,0.22)';
      ctx.fillRect(GUTTER - 1, 0, 1, cssH);

      frames++;
      frameMsAccum += performance.now() - t0;
      const now = performance.now();
      if (now - lastFpsReport >= 500) {
        p.onFps?.((frames * 1000) / (now - lastFpsReport), frameMsAccum / Math.max(1, frames));
        frames = 0;
        frameMsAccum = 0;
        lastFpsReport = now;
      }
      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
    // Intentionally empty: the loop reads everything through propsRef, so it is started exactly once
    // and never restarted. Restarting a rAF loop on prop changes is the classic source of jank here.
  }, []);

  return <canvas ref={canvasRef} className="block w-full" />;
}
