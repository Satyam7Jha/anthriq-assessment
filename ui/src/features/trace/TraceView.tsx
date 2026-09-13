import { useEffect, useRef } from 'react';
import uCharts from '@qiun/ucharts';
import type { Envelopes, Marker } from '../../types';
import { fmtPosition, fmtTick } from '../../lib/format';
import { GUTTER, targetOf, tickStep } from './motion';

/**
 * Stacked per-channel traces on a shared time axis — the way multi-channel ExG is read — drawn by
 * uCharts, with a transparent overlay for what uCharts has no concept of.
 *
 * Traces. uCharts has no min/max band and no per-row panes, so each channel is one line series offset
 * into its own lane, zig-zagging through each column's maximum and then its minimum, so a single-sample
 * spike still reaches its full height. Columns arrive on an absolute grid of whole samples, so as the
 * window moves a column keeps the same samples and the trace slides rather than shimmering. A row
 * rescales only when its signal leaves the lane or shrinks to under half of it.
 *
 * Motion. The window follows motion.ts: it keeps moving between data frames at the speed each frame
 * reports. The x axis is a list of categories, so the chart redraws when the view has moved by a
 * whole column or new data has arrived. uCharts' own animation tweens a whole dataset and restarts on
 * every update, which never settles on streaming data, so it is off.
 *
 * Overlay. Lost-sample bands, the crosshair and the value readout are drawn on a second canvas from
 * the same geometry, so hovering never forces a chart redraw.
 */

const PAD_TOP = 12;
const PAD_RIGHT = 12;
const AXIS_PX = 26; // the time-label band below the plot
const EASE_MS = 140;

interface Palette {
  trace: string;
  label: string;
  channel: string;
  gap: string;
  gapEdge: string;
  crosshair: string;
}

function readPalette(el: Element): Palette {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return { trace: v('--trace'), label: v('--label-2'), channel: v('--label-2'), gap: v('--gap'), gapEdge: v('--gap-edge'), crosshair: v('--crosshair') };
}

export interface TraceViewProps {
  envelopesRef: React.RefObject<Envelopes | null>;
  markers: Marker[];
  windowSeconds: number;
  onFrameTime?: (ms: number) => void;
}

interface Shown {
  env: Envelopes;
  first: number;
  count: number;
}

export function TraceView(props: TraceViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const labelsRef = useRef<HTMLDivElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const container = containerRef.current;
    const canvas = chartRef.current;
    const overlay = overlayRef.current;
    const labels = labelsRef.current;
    const tip = tipRef.current;
    const ctx = canvas?.getContext('2d');
    const octx = overlay?.getContext('2d');
    if (!container || !canvas || !overlay || !labels || !tip || !ctx || !octx) return;

    const palette = readPalette(container);
    let chart: uCharts | null = null;
    let cssW = 0;
    let cssH = 0;
    let dpr = 1;
    let shown: Shown | null = null;
    let pointer: { x: number; y: number } | null = null;
    let overlayDirty = true;
    let start = Number.NaN;
    let lastKey = '';
    let labelKey = '';
    let lastMarkers: Marker[] | null = null;
    let lastTime = performance.now();
    let total = 0;
    let draws = 0;
    let reported = performance.now();
    let raf = 0;
    // The range each row is fitted to, kept until the signal leaves it.
    let fitKey = '';
    let fitCentre = new Float64Array(0);
    let fitHalf = new Float64Array(0);

    // Plot geometry in CSS pixels. With a justified category axis, point k of n sits at left + k·spacing.
    const left = GUTTER;
    const right = () => cssW - PAD_RIGHT;
    const bottom = () => cssH - AXIS_PX;
    const spacing = (s: Shown) => (right() - left) / Math.max(1, s.count * 2 - 1);
    const xOfTime = (s: Shown, t: number) => left + ((t - s.env.fromSeconds) / s.env.columnSeconds - s.first - 0.5) * 2 * spacing(s) + spacing(s) / 2;

    const resize = () => {
      const r = container.getBoundingClientRect();
      cssW = r.width;
      cssH = r.height;
      dpr = window.devicePixelRatio || 1;
      for (const c of [canvas, overlay]) {
        c.width = Math.max(1, Math.round(cssW * dpr));
        c.height = Math.max(1, Math.round(cssH * dpr));
        c.style.width = `${cssW}px`;
        c.style.height = `${cssH}px`;
      }
      chart = null; // uCharts fixes its size at construction
      lastKey = '';
      overlayDirty = true;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    const onMove = (e: PointerEvent) => {
      const r = overlay.getBoundingClientRect();
      pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
      overlayDirty = true;
    };
    const onLeave = () => {
      pointer = null;
      overlayDirty = true;
    };
    overlay.addEventListener('pointermove', onMove);
    overlay.addEventListener('pointerleave', onLeave);

    function drawChart(env: Envelopes, first: number, count: number, windowSeconds: number): void {
      const rows = env.channels.length;
      const cols = env.columns;
      const step = tickStep(windowSeconds);
      const key = env.channels.join(',');
      if (key !== fitKey) {
        fitKey = key;
        fitCentre = new Float64Array(rows).fill(Number.NaN);
        fitHalf = new Float64Array(rows).fill(Number.NaN);
      }

      // Two points per column (its maximum, then its minimum), so the zig-zag keeps every peak.
      const categories: string[] = new Array(count * 2);
      for (let i = 0; i < count; i++) {
        categories[i * 2] = fmtTick(Math.max(0, env.fromSeconds + (first + i + 0.5) * env.columnSeconds), step);
        categories[i * 2 + 1] = '';
      }
      const series = env.channels.map((ch, r) => {
        const base = r * cols * 2;
        let lo = Infinity;
        let hi = -Infinity;
        for (let c = Math.max(0, first); c < Math.min(cols, first + count); c++) {
          const a = env.data[base + c * 2]!;
          if (a !== a) continue;
          lo = Math.min(lo, a);
          hi = Math.max(hi, env.data[base + c * 2 + 1]!);
        }
        const data: (number | null)[] = new Array(count * 2).fill(null);
        if (lo !== Infinity) {
          const want = Math.max((hi - lo) / 2, 1e-6) / 0.8;
          if (fitHalf[r] !== fitHalf[r] || hi > fitCentre[r]! + fitHalf[r]! || lo < fitCentre[r]! - fitHalf[r]! || want < fitHalf[r]! * 0.5) {
            fitCentre[r] = (lo + hi) / 2;
            fitHalf[r] = want;
          }
          const lane = rows - r - 0.5; // the y axis runs bottom-up
          for (let i = 0; i < count; i++) {
            const c = first + i;
            if (c < 0 || c >= cols) continue;
            const a = env.data[base + c * 2]!;
            if (a !== a) continue;
            data[i * 2] = lane + ((env.data[base + c * 2 + 1]! - fitCentre[r]!) / fitHalf[r]!) * 0.5;
            data[i * 2 + 1] = lane + ((a - fitCentre[r]!) / fitHalf[r]!) * 0.5;
          }
        }
        return { name: `Channel ${ch + 1}`, data, color: palette.trace, pointShape: 'none' };
      });

      const t0 = performance.now();
      if (!chart) {
        chart = new uCharts({
          type: 'line',
          context: ctx,
          width: canvas!.width,
          height: canvas!.height,
          pixelRatio: dpr,
          categories,
          series,
          animation: false,
          background: '#FFFFFF',
          padding: [PAD_TOP, PAD_RIGHT, 0, GUTTER],
          fontSize: 11,
          fontColor: palette.label,
          legend: { show: false },
          dataLabel: false,
          dataPointShape: false,
          // One grid line per category would be a grey wash at two categories per pixel column.
          xAxis: { labelCount: 10, axisLine: false, disableGrid: true, fontColor: palette.label, fontSize: 11, boundaryGap: 'justify' },
          yAxis: { disabled: true, disableGrid: true, data: [{ min: 0, max: rows, disabled: true }] },
          extra: { line: { type: 'straight', width: 1 }, tooltip: { showBox: false } },
        });
      } else {
        chart.updateData({ categories, series });
      }
      total += performance.now() - t0;
      draws++;

      if (key !== labelKey) {
        labelKey = key;
        labels!.innerHTML = env.channels.map((ch, r) => `<span style="position:absolute;right:0;top:${((r + 0.5) * 100) / rows}%;transform:translateY(-50%)">${ch + 1}</span>`).join('');
      }
      shown = { env, first, count };
      overlayDirty = true;
    }

    function drawOverlay(markers: Marker[]): void {
      octx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      octx!.clearRect(0, 0, cssW, cssH);
      const s = shown;
      if (!s) {
        tip!.hidden = true;
        return;
      }
      const top = PAD_TOP;
      const b = bottom();
      const r0 = right();

      // Lost data: a soft band across every row, with a firmer line where it begins.
      for (const m of markers) {
        const x0 = xOfTime(s, m.onsetSeconds);
        const a = Math.max(x0, left);
        const e = Math.min(xOfTime(s, m.onsetSeconds + m.durationSeconds), r0);
        if (e <= left || a >= r0) continue;
        octx!.fillStyle = palette.gap;
        octx!.fillRect(a, top, Math.max(1, e - a), b - top);
        if (x0 >= left) {
          octx!.fillStyle = palette.gapEdge;
          octx!.fillRect(Math.round(a), top, 1, b - top);
        }
      }

      // Crosshair and the reading under the pointer: the range of samples in that column.
      if (pointer && pointer.x >= left && pointer.x <= r0 && pointer.y >= top && pointer.y <= b) {
        const rows = s.env.channels.length;
        const r = Math.min(rows - 1, Math.max(0, Math.floor(((pointer.y - top) / (b - top)) * rows)));
        const c = s.first + Math.floor((pointer.x - left) / (2 * spacing(s)));
        const inData = c >= 0 && c < s.env.columns;
        const lo = inData ? s.env.data[r * s.env.columns * 2 + c * 2]! : Number.NaN;
        const hi = inData ? s.env.data[r * s.env.columns * 2 + c * 2 + 1]! : Number.NaN;
        const t = s.env.fromSeconds + (c + 0.5) * s.env.columnSeconds;
        octx!.fillStyle = palette.crosshair;
        octx!.fillRect(Math.round(pointer.x), top, 1, b - top);
        const value = lo !== lo ? 'no data' : hi - lo < 1e-4 ? lo.toFixed(4) : `${lo.toFixed(3)} to ${hi.toFixed(3)}`;
        tip!.innerHTML = `<b style="font-weight:600">Channel ${s.env.channels[r]! + 1}</b><span style="color:${palette.channel}">&nbsp;&nbsp;${fmtPosition(Math.max(0, t))}&nbsp;&nbsp;</span><span style="font-variant-numeric:tabular-nums">${value}</span>`;
        tip!.hidden = false;
        const w = tip!.offsetWidth;
        tip!.style.transform = `translate(${pointer.x + 16 + w > cssW ? pointer.x - 16 - w : pointer.x + 16}px, ${Math.max(0, Math.min(pointer.y - 14, cssH - 40))}px)`;
      } else {
        tip!.hidden = true;
      }
    }

    const tick = (now: number) => {
      const p = propsRef.current;
      const env = p.envelopesRef.current;
      const dtMs = Math.min(100, now - lastTime);
      lastTime = now;
      if (env && cssW > 0) {
        const target = targetOf(env, p.windowSeconds, now);
        if (start !== start || Math.abs(target.start - start) > p.windowSeconds * 0.5) start = target.start;
        else {
          start += target.velocity * (dtMs / 1000);
          start += (target.start - start) * (1 - Math.exp(-dtMs / EASE_MS));
        }
        const first = Math.round((start - env.fromSeconds) / env.columnSeconds);
        const count = Math.max(2, Math.round(p.windowSeconds / env.columnSeconds));
        const key = `${env.receivedAt}:${first}:${count}:${canvas.width}x${canvas.height}:${env.channels.join(',')}`;
        if (key !== lastKey) {
          drawChart(env, first, count, p.windowSeconds);
          lastKey = key;
        }
      }
      if (p.markers !== lastMarkers) {
        lastMarkers = p.markers;
        overlayDirty = true;
      }
      if (overlayDirty) {
        overlayDirty = false;
        drawOverlay(p.markers);
      }
      if (draws > 0 && now - reported > 1000) {
        p.onFrameTime?.(total / draws);
        total = draws = 0;
        reported = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      overlay.removeEventListener('pointermove', onMove);
      overlay.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden">
      <canvas ref={chartRef} aria-hidden className="absolute inset-0 block" />
      <canvas ref={overlayRef} role="img" aria-label="Signal traces" className="absolute inset-0 block cursor-crosshair" />
      <div ref={labelsRef} aria-hidden className="num pointer-events-none absolute left-0 text-[11px] font-medium text-label-2" style={{ top: PAD_TOP, bottom: AXIS_PX, width: GUTTER - 14 }} />
      <div
        ref={tipRef}
        hidden
        className="pointer-events-none absolute top-0 left-0 z-10 whitespace-nowrap rounded-lg bg-surface px-2.5 py-1.5 text-[12px] text-label shadow-[0_2px_12px_rgba(0,0,0,0.12),0_0_0_0.5px_var(--line)]"
      />
    </div>
  );
}
