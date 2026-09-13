// Pure canvas drawing for the trace view. No React, no state: given a context, data and geometry,
// draw one frame. Kept apart from the component so the render loop reads as a list of steps.

import type { Envelopes, Marker } from '../../types';
import { fmtTick } from '../../lib/format';

export const GUTTER = 44; // channel labels
export const AXIS = 22; // time labels
const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
const FONT = '500 11px -apple-system, BlinkMacSystemFont, sans-serif';

export interface Palette {
  trace: string;
  grid: string;
  label: string;
  text: string;
  gap: string;
  gapEdge: string;
  accent: string;
  surface: string;
}

export function readPalette(el: Element): Palette {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return { trace: v('--trace'), grid: v('--trace-grid'), label: v('--label-3'), text: v('--label'), gap: v('--gap'), gapEdge: v('--gap-edge'), accent: v('--accent'), surface: v('--surface') };
}

export interface Geometry {
  width: number;
  height: number;
  windowStart: number;
  windowSeconds: number;
}

const plotWidth = (g: Geometry) => Math.max(1, g.width - GUTTER);
const plotHeight = (g: Geometry) => Math.max(1, g.height - AXIS);
const toX = (g: Geometry, seconds: number) => GUTTER + ((seconds - g.windowStart) / g.windowSeconds) * plotWidth(g);

/** Round-second ticks and faint gridlines along the shared time axis. */
export function drawAxis(ctx: CanvasRenderingContext2D, g: Geometry, p: Palette): void {
  const step = TICK_STEPS.find((s) => g.windowSeconds / s <= 10) ?? 300;
  ctx.font = FONT;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  for (let t = Math.ceil(g.windowStart / step) * step; t <= g.windowStart + g.windowSeconds + 1e-9; t += step) {
    const x = Math.round(toX(g, t)) + 0.5;
    if (x < GUTTER || x > g.width) continue;
    ctx.fillStyle = p.grid;
    ctx.fillRect(x, 0, 1, plotHeight(g));
    ctx.fillStyle = p.label;
    ctx.fillText(fmtTick(t, step), Math.min(Math.max(x, GUTTER + 14), g.width - 18), plotHeight(g) + AXIS / 2 + 1);
  }
}

/** Lost samples as soft bands across every row: an answer to "where", not just "how many". */
export function drawMarkers(ctx: CanvasRenderingContext2D, g: Geometry, p: Palette, markers: Marker[]): void {
  for (const m of markers) {
    const x0 = Math.max(GUTTER, toX(g, m.onsetSeconds));
    const x1 = Math.min(g.width, toX(g, m.onsetSeconds + m.durationSeconds));
    if (x1 < GUTTER || x0 > g.width) continue;
    ctx.fillStyle = p.gap;
    ctx.fillRect(x0, 0, Math.max(2, x1 - x0), plotHeight(g));
    ctx.fillStyle = p.gapEdge;
    ctx.fillRect(x0, 0, 1, plotHeight(g));
  }
}

/**
 * Stacked rows, one Path2D per channel. Each row fits its own visible range to 80% of its height, so
 * no trace can spill into a neighbour and no scale control is needed.
 */
export function drawTraces(ctx: CanvasRenderingContext2D, g: Geometry, p: Palette, env: Envelopes): void {
  const rows = env.channels.length;
  const rowH = plotHeight(g) / rows;
  const colW = plotWidth(g) / env.columns;
  ctx.font = FONT;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  for (let r = 0; r < rows; r++) {
    const mid = r * rowH + rowH / 2;
    ctx.fillStyle = p.grid;
    ctx.fillRect(GUTTER, Math.round(mid), plotWidth(g), 1);
    if (rowH >= 11) {
      ctx.fillStyle = p.label;
      ctx.fillText(String(env.channels[r]! + 1), GUTTER - 12, mid);
    }
    const base = r * env.columns * 2;
    let lo = Infinity;
    let hi = -Infinity;
    for (let c = 0; c < env.columns; c++) {
      const a = env.data[base + c * 2]!;
      if (a !== a) continue; // NaN: no data in this column
      lo = Math.min(lo, a);
      hi = Math.max(hi, env.data[base + c * 2 + 1]!);
    }
    if (lo === Infinity) continue;
    const centre = (lo + hi) / 2;
    const scale = ((rowH / 2 - 1) * 0.8) / Math.max((hi - lo) / 2, 1e-6);
    const path = new Path2D();
    for (let c = 0; c < env.columns; c++) {
      const a = env.data[base + c * 2]!;
      if (a !== a) continue;
      const top = mid - (env.data[base + c * 2 + 1]! - centre) * scale;
      const bottom = mid - (a - centre) * scale;
      path.rect(GUTTER + c * colW, top, Math.max(0.75, colW), Math.max(0.75, bottom - top));
    }
    ctx.fillStyle = p.trace;
    ctx.fill(path);
  }
}

/** Crosshair, highlighted row, and one quiet readout: time, channel, value. */
export function drawHover(ctx: CanvasRenderingContext2D, g: Geometry, p: Palette, env: Envelopes, x: number, y: number): void {
  if (x < GUTTER || x > g.width || y < 0 || y >= plotHeight(g)) return;
  const rowH = plotHeight(g) / env.channels.length;
  const r = Math.min(env.channels.length - 1, Math.floor(y / rowH));
  const c = Math.min(env.columns - 1, Math.floor(((x - GUTTER) / plotWidth(g)) * env.columns));
  const lo = env.data[r * env.columns * 2 + c * 2]!;
  const hi = env.data[r * env.columns * 2 + c * 2 + 1]!;
  const seconds = g.windowStart + ((x - GUTTER) / plotWidth(g)) * g.windowSeconds;

  ctx.fillStyle = p.grid;
  ctx.fillRect(GUTTER, r * rowH, plotWidth(g), rowH);
  ctx.fillStyle = p.accent;
  ctx.fillRect(Math.round(x), 0, 1, plotHeight(g));

  const value = lo !== lo ? 'no data' : hi - lo < 1e-4 ? lo.toFixed(4) : `${lo.toFixed(3)} … ${hi.toFixed(3)}`;
  const text = `${fmtTick(seconds, 0.1)}   Channel ${env.channels[r]! + 1}   ${value}`;
  ctx.font = FONT;
  const w = ctx.measureText(text).width + 16;
  const bx = Math.min(Math.max(x + 10, GUTTER), g.width - w - 4);
  const by = Math.max(4, Math.min(r * rowH + rowH / 2 - 11, plotHeight(g) - 26));
  ctx.fillStyle = p.surface;
  ctx.shadowColor = 'rgba(0,0,0,0.18)';
  ctx.shadowBlur = 8;
  ctx.beginPath();
  ctx.roundRect(bx, by, w, 22, 6);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = p.text;
  ctx.textAlign = 'left';
  ctx.fillText(text, bx + 8, by + 11.5);
}
