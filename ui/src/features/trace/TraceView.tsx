import { useEffect, useRef } from 'react';
import Highcharts from 'highcharts';
import 'highcharts/highcharts-more';
import 'highcharts/modules/boost';
import type { Envelopes, Marker } from '../../types';
import { fmtTick } from '../../lib/format';

/**
 * Stacked per-channel traces on a shared time axis — the way multi-channel ExG is read.
 *
 * Built on Highcharts: one `arearange` series per channel (each column's min/max envelope is exactly a
 * low/high range), each on its own y-axis pane, all sharing one x-axis. Lost samples are x-axis plot
 * bands. The Boost module draws the series with WebGL so 32 channels refresh at the frame rate.
 *
 * Performance: React never touches pixel data. Envelopes arrive in a ref and a requestAnimationFrame
 * loop pushes them into the chart only when a new frame has arrived; the loop starts once and reads
 * props through refs, so nothing re-renders per frame. The chart is rebuilt only when the channel set
 * or colour scheme changes.
 */

export const GUTTER = 44; // channel labels
const AXIS = 22; // time labels
const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, sans-serif';

interface Palette {
  trace: string;
  grid: string;
  label: string;
  text: string;
  gap: string;
  gapEdge: string;
  accent: string;
  surface: string;
}

function readPalette(el: Element): Palette {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return { trace: v('--trace'), grid: v('--trace-grid'), label: v('--label-3'), text: v('--label'), gap: v('--gap'), gapEdge: v('--gap-edge'), accent: v('--accent'), surface: v('--surface') };
}

const tickStep = (windowSeconds: number) => TICK_STEPS.find((s) => windowSeconds / s <= 10) ?? 300;

function markerBands(markers: Marker[], p: Palette): Pick<Highcharts.XAxisOptions, 'plotBands' | 'plotLines'> {
  return {
    plotBands: markers.map((m) => ({ from: m.onsetSeconds, to: m.onsetSeconds + m.durationSeconds, color: p.gap, zIndex: 1 })),
    plotLines: markers.map((m) => ({ value: m.onsetSeconds, color: p.gapEdge, width: 1, zIndex: 2 })),
  };
}

function buildOptions(channels: number[], p: Palette, props: TraceViewProps): Highcharts.Options {
  const rows = channels.length;
  const label = { color: p.label, fontSize: '11px', fontWeight: '500' };
  return {
    chart: {
      animation: false,
      backgroundColor: 'transparent',
      margin: [0, 0, AXIS, GUTTER],
      spacing: [0, 0, 0, 0],
      style: { fontFamily: FONT_FAMILY },
    },
    accessibility: { enabled: false },
    // GPU translations also turn off Boost's CPU culling of points within a pixel of the last one,
    // which otherwise drops adjacent columns and leaves steep segments dotted.
    boost: { seriesThreshold: 1, useGPUTranslations: true },
    credits: { enabled: false },
    legend: { enabled: false },
    title: { text: undefined },
    xAxis: {
      min: props.windowStart,
      max: props.windowStart + props.windowSeconds,
      gridLineWidth: 1,
      gridLineColor: p.grid,
      lineWidth: 0,
      tickLength: 0,
      crosshair: { color: p.accent, width: 1, zIndex: 5 },
      tickPositioner() {
        const step = tickStep(this.max! - this.min!);
        const ticks: number[] = [];
        for (let t = Math.ceil(this.min! / step) * step; t <= this.max! + 1e-9; t += step) ticks.push(t);
        return ticks;
      },
      labels: {
        style: label,
        y: 15,
        overflow: 'justify',
        formatter() {
          return fmtTick(Number(this.value), tickStep(this.axis.max! - this.axis.min!));
        },
      },
      ...markerBands(props.markers, p),
    },
    // One pane per channel. A single mid-row tick gives the row's rule line and its channel label.
    yAxis: channels.map((ch, r) => ({
      top: `${(r * 100) / rows}%`,
      height: `${100 / rows}%`,
      offset: 0,
      title: { text: undefined },
      startOnTick: false,
      endOnTick: false,
      gridLineWidth: 1,
      gridLineColor: p.grid,
      tickPositioner() {
        return this.min == null || this.max == null ? [] : [(this.min + this.max) / 2];
      },
      labels: { style: label, x: -12, formatter: () => String(ch + 1) },
    })),
    tooltip: {
      animation: false,
      hideDelay: 0,
      backgroundColor: p.surface,
      borderWidth: 0,
      borderRadius: 6,
      shadow: { color: 'rgba(0,0,0,0.18)', width: 8, offsetX: 0, offsetY: 0 },
      padding: 6,
      style: { color: p.text, fontSize: '11px', fontWeight: '500' },
      formatter() {
        const point = this as unknown as { x: number; low: number; high: number };
        const value = point.high - point.low < 1e-4 ? point.low.toFixed(4) : `${point.low.toFixed(3)} … ${point.high.toFixed(3)}`;
        return `${fmtTick(point.x, 0.1)}&nbsp;&nbsp;&nbsp;${this.series.name}&nbsp;&nbsp;&nbsp;${value}`;
      },
    },
    plotOptions: {
      series: {
        animation: false,
        turboThreshold: 0,
        boostThreshold: 1,
        stickyTracking: false,
        states: { hover: { enabled: false }, inactive: { enabled: false } },
      },
      arearange: { lineWidth: 0, fillOpacity: 1, marker: { enabled: false } },
    },
    series: channels.map((ch, r) => ({ type: 'arearange', name: `Channel ${ch + 1}`, yAxis: r, color: p.trace, lineColor: p.trace, data: [] })),
  };
}

/**
 * Push one envelope frame into the chart. Each row fits its own visible range to 80% of its height.
 * Boost draws a range as a vertical line from low to high, so a column flatter than a pixel would
 * vanish; every column is padded to at least one pixel tall.
 */
function applyFrame(chart: Highcharts.Chart, env: Envelopes, windowStart: number, windowSeconds: number): void {
  const dt = windowSeconds / env.columns;
  const rowPx = Math.max(1, chart.plotHeight / env.channels.length);
  for (let r = 0; r < env.channels.length; r++) {
    const base = r * env.columns * 2;
    let lo = Infinity;
    let hi = -Infinity;
    for (let c = 0; c < env.columns; c++) {
      const a = env.data[base + c * 2]!;
      if (a !== a) continue; // NaN: no data in this column
      lo = Math.min(lo, a);
      hi = Math.max(hi, env.data[base + c * 2 + 1]!);
    }
    if (lo === Infinity) {
      chart.series[r]?.setData([], false, false, false);
      continue;
    }
    const centre = (lo + hi) / 2;
    const half = Math.max((hi - lo) / 2, 1e-6) / 0.8;
    const minSpan = (2 * half) / rowPx;
    const data: ([number, number, number] | null)[] = new Array(env.columns);
    for (let c = 0; c < env.columns; c++) {
      const a = env.data[base + c * 2]!;
      if (a !== a) {
        data[c] = null; // the range breaks across a gap
        continue;
      }
      const b = env.data[base + c * 2 + 1]!;
      const pad = Math.max(0, minSpan - (b - a)) / 2;
      data[c] = [windowStart + (c + 0.5) * dt, a - pad, b + pad];
    }
    chart.series[r]?.setData(data as Highcharts.PointOptionsType[], false, false, false);
    chart.yAxis[r]?.setExtremes(centre - half, centre + half, false, false);
  }
}

/** Highcharts hides the tooltip when data is replaced; replay the last pointer position after each frame. */
type HoverPointer = Highcharts.Pointer & { onContainerMouseMove(e: Highcharts.PointerEventObject): void };

export interface TraceViewProps {
  envelopesRef: React.RefObject<Envelopes | null>;
  markers: Marker[];
  windowStart: number;
  windowSeconds: number;
  onFrameTime?: (ms: number) => void;
}

export function TraceView(props: TraceViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let palette = readPalette(container);
    let chart: Highcharts.Chart | null = null;
    let channelKey = '';
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => {
      palette = readPalette(container);
      channelKey = ''; // forces a rebuild with the new colours
    };
    scheme.addEventListener('change', onScheme);

    let mouse: MouseEvent | null = null;
    const onMove = (e: MouseEvent) => (mouse = e);
    const onLeave = () => (mouse = null);
    container.addEventListener('mousemove', onMove);
    container.addEventListener('mouseleave', onLeave);

    let lastEnv: Envelopes | null = null;
    let lastMarkers: Marker[] | null = null;
    let lastWindow = '';
    let raf = 0;
    let total = 0;
    let frames = 0;
    let reported = performance.now();
    const tick = () => {
      const p = propsRef.current;
      const env = p.envelopesRef.current;
      const window = `${p.windowStart}:${p.windowSeconds}`;
      const channels = env?.channels ?? [];
      const key = channels.join(',');

      if (env !== lastEnv || p.markers !== lastMarkers || window !== lastWindow || key !== channelKey) {
        const t0 = performance.now();
        if (key !== channelKey || !chart) {
          chart?.destroy();
          chart = Highcharts.chart(container, buildOptions(channels, palette, p));
          channelKey = key;
          lastMarkers = p.markers;
        } else if (p.markers !== lastMarkers) {
          chart.xAxis[0]!.update(markerBands(p.markers, palette), false);
          lastMarkers = p.markers;
        }
        chart.xAxis[0]!.setExtremes(p.windowStart, p.windowStart + p.windowSeconds, false, false);
        if (env && env.channels.length > 0) applyFrame(chart, env, p.windowStart, p.windowSeconds);
        // While the pointer is over the chart, build the hover search index synchronously so the
        // tooltip can be replayed right after new data; otherwise leave Highcharts to build it lazily.
        for (const s of chart.series) (s.options as { kdNow?: boolean }).kdNow = mouse !== null;
        chart.redraw(false);
        if (mouse) {
          const pointer = chart.pointer as HoverPointer;
          pointer.onContainerMouseMove(pointer.normalize(mouse));
        }
        lastEnv = env;
        lastWindow = window;

        total += performance.now() - t0;
        frames++;
      }

      if (frames > 0 && performance.now() - reported > 1000) {
        p.onFrameTime?.(total / frames);
        total = frames = 0;
        reported = performance.now();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      scheme.removeEventListener('change', onScheme);
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mouseleave', onLeave);
      chart?.destroy();
    };
  }, []);

  return <div ref={containerRef} role="img" aria-label="Signal traces" className="block h-full w-full cursor-crosshair" />;
}
