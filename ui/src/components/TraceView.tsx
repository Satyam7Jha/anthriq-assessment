import { useEffect, useRef } from 'react';
import type { Envelopes, Marker } from '../types';

/**
 * Stacked per-channel traces on one shared time axis — the way multi-channel ExG is actually read.
 *
 * Performance rules, unchanged from the first version because they were right:
 *   - React never touches pixel data. Envelopes live in a ref; a requestAnimationFrame loop draws
 *     them. Zero re-renders per frame.
 *   - The loop starts once and reads everything through refs, so no prop change restarts it.
 *   - One Path2D per channel: 32 fills a frame, not 32 x columns draw calls.
 *   - A trace is clipped to its own row. Overdrawing a neighbour would attribute one electrode's
 *     artefact to another.
 */

export interface TraceViewProps {
  envelopesRef: React.RefObject<Envelopes | null>;
  markers: Marker[];
  windowStartSeconds: number;
  windowSeconds: number;
  onFrameTime?: (ms: number) => void;
}

const GUTTER = 44;

interface Palette {
  trace: string;
  grid: string;
  label: string;
  gap: string;
  gapEdge: string;
}

function readPalette(el: Element): Palette {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    trace: v('--trace'),
    grid: v('--trace-grid'),
    label: v('--label-3'),
    gap: v('--gap'),
    gapEdge: v('--gap-edge'),
  };
}

export function TraceView(props: TraceViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Colours come from the same CSS variables as the rest of the page, re-read when the system
    // switches between light and dark, never per frame.
    let palette = readPalette(canvas);
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => (palette = readPalette(canvas));
    scheme.addEventListener('change', onScheme);

    let raf = 0;
    let acc = 0;
    let n = 0;
    let lastReport = performance.now();

    const draw = () => {
      const t0 = performance.now();
      const p = propsRef.current;
      const env = p.envelopesRef.current;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const plotW = Math.max(1, w - GUTTER);
      const rows = env?.channels.length ?? 0;
      const rowH = rows > 0 ? h / rows : h;

      // Loss, drawn under the traces and across every row: the answer to "where", not just "how much".
      for (const m of p.markers) {
        const x0 = GUTTER + ((m.onsetSeconds - p.windowStartSeconds) / p.windowSeconds) * plotW;
        const x1 = GUTTER + ((m.onsetSeconds + m.durationSeconds - p.windowStartSeconds) / p.windowSeconds) * plotW;
        if (x1 < GUTTER || x0 > w) continue;
        const left = Math.max(GUTTER, x0);
        ctx.fillStyle = palette.gap;
        ctx.fillRect(left, 0, Math.max(2, Math.min(w, x1) - left), h);
        ctx.fillStyle = palette.gapEdge;
        ctx.fillRect(left, 0, 1, h);
      }

      if (env && rows > 0) {
        const cols = env.columns;
        const colW = plotW / cols;
        ctx.font = `500 ${Math.min(11, Math.max(9, rowH * 0.42))}px -apple-system, BlinkMacSystemFont, sans-serif`;
        ctx.textBaseline = 'middle';

        for (let r = 0; r < rows; r++) {
          const yTop = r * rowH;
          const yMid = yTop + rowH / 2;
          const half = rowH / 2 - 1;

          ctx.fillStyle = palette.grid;
          ctx.fillRect(GUTTER, Math.round(yMid), plotW, 1);

          if (rowH >= 11) {
            ctx.fillStyle = palette.label;
            ctx.textAlign = 'right';
            ctx.fillText(String(env.channels[r]! + 1), GUTTER - 12, yMid);
          }

          // Each row fits its own visible range to 80% of the row. No scale control, and no trace can
          // ever spill into its neighbour — the two things that made the dense view unreadable.
          const base = r * cols * 2;
          let mn = Infinity;
          let mx = -Infinity;
          for (let c = 0; c < cols; c++) {
            const lo = env.data[base + c * 2]!;
            if (lo !== lo) continue;
            if (lo < mn) mn = lo;
            const hi = env.data[base + c * 2 + 1]!;
            if (hi > mx) mx = hi;
          }
          if (mn === Infinity) continue;
          const mid = (mn + mx) / 2;
          const scale = (half * 0.8) / Math.max((mx - mn) / 2, 1e-6);

          const path = new Path2D();
          for (let c = 0; c < cols; c++) {
            const lo = env.data[base + c * 2]!;
            if (lo !== lo) continue;
            const hi = env.data[base + c * 2 + 1]!;
            const yHi = yMid - (hi - mid) * scale;
            const yLo = yMid - (lo - mid) * scale;
            path.rect(GUTTER + c * colW, yHi, Math.max(0.75, colW), Math.max(0.75, yLo - yHi));
          }
          ctx.fillStyle = palette.trace;
          ctx.fill(path);
        }
      }

      acc += performance.now() - t0;
      n++;
      const now = performance.now();
      if (now - lastReport > 1000) {
        p.onFrameTime?.(acc / n);
        acc = 0;
        n = 0;
        lastReport = now;
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      scheme.removeEventListener('change', onScheme);
    };
  }, []);

  return <canvas ref={canvasRef} className="block h-full w-full" />;
}
