import { useEffect, useRef } from 'react';
import type { Envelopes, Marker } from '../../types';
import { fmtPosition, fmtTick } from '../../lib/format';

/**
 * Stacked per-channel traces on a shared time axis — the way multi-channel ExG is read — drawn on a
 * 2D canvas.
 *
 * Motion. Data arrives about twenty times a second, but the view moves on every display frame. Each
 * data frame says where the window should be and how fast it is moving (1× while a recording grows,
 * the playback speed during review, 0 when paused); the view advances at that speed and eases out any
 * difference, so it glides instead of jumping. The server sends TRACE_PAD_SECONDS more than the visible
 * window, so the glide never runs past the data. A live recording is committed in one-second blocks,
 * so the live view trails the newest data by about a block and scrolls continuously rather than in
 * steps. Each row eases toward its fitted range too, so the scale settles instead of twitching.
 *
 * Drawing. Each channel is its min/max envelope as one filled band: the top edge runs through the
 * column maxima and the bottom edge back through the minima. Consecutive columns are joined, so a
 * steep edge (the drop of a sawtooth) is drawn and a slope stays smooth, while a single-sample spike
 * still reaches its full height. Lost data breaks the band.
 *
 * Performance. React never touches pixel data: envelopes arrive in a ref, one requestAnimationFrame
 * loop reads props through refs, and it redraws only while something is moving or has changed.
 */

export const GUTTER = 44; // channel labels
export const TRACE_PAD_SECONDS = 2; // data requested beyond the visible window, split around it
const RIGHT = 10;
const TOP = 4;
const AXIS = 24;
const LIVE_DELAY_SECONDS = 1.1; // one committed block, plus the time to fetch it
const EASE_MS = 140;
const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
const FONT = '500 11px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif';

interface Palette {
  trace: string;
  grid: string;
  band: string;
  crosshair: string;
  label: string;
  channel: string;
  gap: string;
  gapEdge: string;
  surface: string;
}

function readPalette(el: Element): Palette {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    trace: v('--trace'),
    grid: v('--trace-grid'),
    band: v('--row-band'),
    crosshair: v('--crosshair'),
    label: v('--label-3'),
    channel: v('--label-2'),
    gap: v('--gap'),
    gapEdge: v('--gap-edge'),
    surface: v('--surface'),
  };
}

const tickStep = (windowSeconds: number) => TICK_STEPS.find((s) => windowSeconds / s <= 10) ?? 300;

/** Where the window should start at `now`, and how fast it is moving, according to the latest data frame. */
function targetOf(env: Envelopes, windowSeconds: number, now: number): { start: number; velocity: number } {
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

export interface TraceViewProps {
  envelopesRef: React.RefObject<Envelopes | null>;
  markers: Marker[];
  windowSeconds: number;
  onFrameTime?: (ms: number) => void;
}

export function TraceView(props: TraceViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const tip = tipRef.current;
    const ctx = canvas?.getContext('2d');
    if (!container || !canvas || !tip || !ctx) return;

    const palette = readPalette(container);
    let cssW = 0;
    let cssH = 0;
    let dpr = 1;
    let dirty = true;

    const resize = () => {
      const r = container.getBoundingClientRect();
      cssW = r.width;
      cssH = r.height;
      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(cssW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      dirty = true;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    let pointer: { x: number; y: number } | null = null;
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
      dirty = true;
    };
    const onLeave = () => {
      pointer = null;
      dirty = true;
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);

    let start = Number.NaN;
    let lastEnv: Envelopes | null = null;
    let lastWindow = 0;
    let lastMarkers: Marker[] | null = null;
    let lastTime = performance.now();
    // Per-row fitted range, eased; reset when the channel set changes.
    let rowKey = '';
    let centre = new Float64Array(0);
    let half = new Float64Array(0);
    // The range each row is fitted to. It changes only when the signal leaves the row or shrinks to
    // under half of it, so rows hold still while data scrolls through them.
    let fitCentre = new Float64Array(0);
    let fitHalf = new Float64Array(0);
    let total = 0;
    let draws = 0;
    let reported = performance.now();
    let raf = 0;

    function draw(env: Envelopes | null, windowSeconds: number, markers: Marker[], ease: number): boolean {
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.clearRect(0, 0, cssW, cssH);
      const plotX = GUTTER;
      const plotY = TOP;
      const plotW = Math.max(1, cssW - GUTTER - RIGHT);
      const plotH = Math.max(1, cssH - TOP - AXIS);
      const S = env ? start : 0;
      const xOf = (t: number) => plotX + ((t - S) / windowSeconds) * plotW;
      const channels = env?.channels ?? [];
      const rows = channels.length;
      const rowH = rows ? plotH / rows : plotH;
      let settling = false;

      // Lanes: a faint band on every other row, instead of a rule line per row.
      ctx!.fillStyle = palette.band;
      for (let r = 1; r < rows; r += 2) ctx!.fillRect(plotX, plotY + r * rowH, plotW, rowH);

      // Time grid and labels, which scroll with the traces.
      const step = tickStep(windowSeconds);
      ctx!.strokeStyle = palette.grid;
      ctx!.lineWidth = 1;
      ctx!.beginPath();
      ctx!.font = FONT;
      ctx!.textAlign = 'center';
      ctx!.textBaseline = 'top';
      ctx!.fillStyle = palette.label;
      for (let k = Math.ceil(S / step); k * step <= S + windowSeconds + 1e-9; k++) {
        const x = Math.round(xOf(k * step)) + 0.5;
        ctx!.moveTo(x, plotY);
        ctx!.lineTo(x, plotY + plotH);
        if (x > plotX + 12 && x < plotX + plotW - 12) ctx!.fillText(fmtTick(k * step, step), x, plotY + plotH + 8);
      }
      ctx!.stroke();

      // Lost data: a soft band across every row, with a firmer line where it begins.
      for (const m of markers) {
        const a = Math.max(xOf(m.onsetSeconds), plotX);
        const b = Math.min(xOf(m.onsetSeconds + m.durationSeconds), plotX + plotW);
        if (b <= plotX || a >= plotX + plotW) continue;
        ctx!.fillStyle = palette.gap;
        ctx!.fillRect(a, plotY, Math.max(1, b - a), plotH);
        if (xOf(m.onsetSeconds) >= plotX) {
          ctx!.fillStyle = palette.gapEdge;
          ctx!.fillRect(Math.round(a), plotY, 1, plotH);
        }
      }

      // Channel labels.
      ctx!.textAlign = 'right';
      ctx!.textBaseline = 'middle';
      ctx!.fillStyle = palette.channel;
      for (let r = 0; r < rows; r++) ctx!.fillText(String(channels[r]! + 1), GUTTER - 14, plotY + (r + 0.5) * rowH);

      if (env && rows > 0) {
        const cols = env.columns;
        const colDt = env.columnSeconds;
        const c0 = Math.max(0, Math.floor((S - env.fromSeconds) / colDt) - 1);
        const c1 = Math.min(cols - 1, Math.ceil((S + windowSeconds - env.fromSeconds) / colDt) + 1);
        const key = channels.join(',');
        if (key !== rowKey) {
          rowKey = key;
          centre = new Float64Array(rows).fill(Number.NaN);
          half = new Float64Array(rows).fill(Number.NaN);
          fitCentre = new Float64Array(rows).fill(Number.NaN);
          fitHalf = new Float64Array(rows).fill(Number.NaN);
        }

        ctx!.save();
        ctx!.beginPath();
        ctx!.rect(plotX, plotY, plotW, plotH);
        ctx!.clip();
        ctx!.fillStyle = palette.trace;
        ctx!.strokeStyle = palette.trace;
        ctx!.lineWidth = 1;
        ctx!.lineJoin = 'round';

        for (let r = 0; r < rows; r++) {
          const base = r * cols * 2;
          // Fit this row to what is visible, and ease toward it.
          let lo = Infinity;
          let hi = -Infinity;
          for (let c = c0; c <= c1; c++) {
            const a = env.data[base + c * 2]!;
            if (a !== a) continue;
            if (a < lo) lo = a;
            const b = env.data[base + c * 2 + 1]!;
            if (b > hi) hi = b;
          }
          if (lo === Infinity) continue;
          const wantHalf = Math.max((hi - lo) / 2, 1e-6) / 0.8;
          const leaves = fitHalf[r] !== fitHalf[r] || hi > fitCentre[r]! + fitHalf[r]! || lo < fitCentre[r]! - fitHalf[r]! || wantHalf < fitHalf[r]! * 0.5;
          if (leaves) {
            fitCentre[r] = (lo + hi) / 2;
            fitHalf[r] = wantHalf;
          }
          const targetCentre = fitCentre[r]!;
          const targetHalf = fitHalf[r]!;
          if (centre[r] !== centre[r]) {
            centre[r] = targetCentre;
            half[r] = targetHalf;
          } else {
            centre[r]! += (targetCentre - centre[r]!) * ease;
            half[r]! += (targetHalf - half[r]!) * ease;
            if (Math.abs(targetHalf - half[r]!) > targetHalf * 1e-3 || Math.abs(targetCentre - centre[r]!) > targetHalf * 1e-3) settling = true;
          }
          const mid = plotY + (r + 0.5) * rowH;
          const scale = rowH / 2 / half[r]!;
          const yOf = (v: number) => mid - (v - centre[r]!) * scale;

          // One band per run of columns with data: forward along the maxima, back along the minima.
          let c = c0;
          while (c <= c1) {
            while (c <= c1 && env.data[base + c * 2]! !== env.data[base + c * 2]!) c++;
            const runStart = c;
            while (c <= c1 && env.data[base + c * 2]! === env.data[base + c * 2]!) c++;
            const runEnd = c - 1;
            if (runEnd < runStart) continue;
            ctx!.beginPath();
            for (let i = runStart; i <= runEnd; i++) ctx!.lineTo(xOf(env.fromSeconds + (i + 0.5) * colDt), yOf(env.data[base + i * 2 + 1]!));
            for (let i = runEnd; i >= runStart; i--) ctx!.lineTo(xOf(env.fromSeconds + (i + 0.5) * colDt), yOf(env.data[base + i * 2]!));
            ctx!.closePath();
            ctx!.fill();
            ctx!.stroke();
          }
        }
        ctx!.restore();

        // Crosshair, a dot on the trace under the pointer, and its reading.
        const inside = pointer && pointer.x >= plotX && pointer.x <= plotX + plotW && pointer.y >= plotY && pointer.y <= plotY + plotH;
        if (pointer && inside) {
          const t = S + ((pointer.x - plotX) / plotW) * windowSeconds;
          const r = Math.min(rows - 1, Math.max(0, Math.floor((pointer.y - plotY) / rowH)));
          const c = Math.floor((t - env.fromSeconds) / colDt);
          const lo = c >= 0 && c < cols ? env.data[r * cols * 2 + c * 2]! : Number.NaN;
          const hi = c >= 0 && c < cols ? env.data[r * cols * 2 + c * 2 + 1]! : Number.NaN;
          ctx!.fillStyle = palette.crosshair;
          ctx!.fillRect(Math.round(pointer.x), plotY, 1, plotH);
          if (lo === lo && half[r] === half[r]) {
            const y = plotY + (r + 0.5) * rowH - ((lo + hi) / 2 - centre[r]!) * (rowH / 2 / half[r]!);
            ctx!.beginPath();
            ctx!.arc(pointer.x, y, 3, 0, Math.PI * 2);
            ctx!.fillStyle = palette.surface;
            ctx!.fill();
            ctx!.lineWidth = 1.5;
            ctx!.strokeStyle = palette.trace;
            ctx!.stroke();
          }
          const value = lo !== lo ? 'no data' : hi - lo < 1e-4 ? lo.toFixed(4) : `${lo.toFixed(3)} to ${hi.toFixed(3)}`;
          tip!.innerHTML = `<b style="font-weight:600">Channel ${channels[r]! + 1}</b><span style="color:${palette.channel}">&nbsp;&nbsp;${fmtPosition(Math.max(0, t))}&nbsp;&nbsp;</span><span style="font-variant-numeric:tabular-nums">${value}</span>`;
          tip!.hidden = false;
          const w = tip!.offsetWidth;
          tip!.style.transform = `translate(${pointer.x + 16 + w > cssW ? pointer.x - 16 - w : pointer.x + 16}px, ${Math.max(0, Math.min(pointer.y - 14, cssH - 40))}px)`;
        } else {
          tip!.hidden = true;
        }
      } else {
        tip!.hidden = true;
      }
      return settling;
    }

    const tick = (now: number) => {
      const p = propsRef.current;
      const env = p.envelopesRef.current;
      const dtMs = Math.min(100, now - lastTime);
      lastTime = now;
      const ease = 1 - Math.exp(-dtMs / EASE_MS);
      let moving = false;

      if (env) {
        const target = targetOf(env, p.windowSeconds, now);
        const jump = Math.abs(target.start - start) > p.windowSeconds * 0.5;
        if (start !== start || jump || p.windowSeconds !== lastWindow) {
          start = target.start;
        } else {
          start += target.velocity * (dtMs / 1000);
          start += (target.start - start) * ease;
        }
        moving = target.velocity !== 0 || Math.abs(target.start - start) > 1e-4;
      }
      if (env !== lastEnv || p.windowSeconds !== lastWindow || p.markers !== lastMarkers) dirty = true;
      lastEnv = env;
      lastWindow = p.windowSeconds;
      lastMarkers = p.markers;

      if (moving || dirty) {
        const t0 = performance.now();
        dirty = draw(env, p.windowSeconds, p.markers, ease);
        total += performance.now() - t0;
        draws++;
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
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden">
      <canvas ref={canvasRef} role="img" aria-label="Signal traces" className="absolute inset-0 block cursor-crosshair" />
      <div
        ref={tipRef}
        hidden
        className="pointer-events-none absolute top-0 left-0 z-10 whitespace-nowrap rounded-lg bg-surface px-2.5 py-1.5 text-[12px] text-label shadow-[0_2px_12px_rgba(0,0,0,0.12),0_0_0_0.5px_var(--line)]"
      />
    </div>
  );
}
