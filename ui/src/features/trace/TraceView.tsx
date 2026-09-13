import { useEffect, useRef } from 'react';
import type { Envelopes, Marker } from '../../types';
import { drawAxis, drawHover, drawMarkers, drawTraces, readPalette } from './draw';

/**
 * Stacked per-channel traces on a shared time axis — the way multi-channel ExG is read.
 *
 * Performance: React never touches pixel data. Envelopes arrive in a ref and a requestAnimationFrame
 * loop draws them; the loop starts once and reads props and the pointer through refs, so nothing
 * re-renders or restarts per frame. A charting library would render each point as a chart element;
 * this receives a pre-decimated envelope and draws 32 channels in about a millisecond.
 */

export interface TraceViewProps {
  envelopesRef: React.RefObject<Envelopes | null>;
  markers: Marker[];
  windowStart: number;
  windowSeconds: number;
  onFrameTime?: (ms: number) => void;
}

export function TraceView(props: TraceViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    let palette = readPalette(canvas);
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => (palette = readPalette(canvas));
    scheme.addEventListener('change', onScheme);

    let pointer: { x: number; y: number } | null = null;
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onLeave = () => (pointer = null);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);

    let raf = 0;
    let total = 0;
    let frames = 0;
    let reported = performance.now();
    const draw = () => {
      const t0 = performance.now();
      const p = propsRef.current;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const g = { width: canvas.clientWidth, height: canvas.clientHeight, windowStart: p.windowStart, windowSeconds: p.windowSeconds };
      if (canvas.width !== Math.round(g.width * dpr) || canvas.height !== Math.round(g.height * dpr)) {
        canvas.width = Math.round(g.width * dpr);
        canvas.height = Math.round(g.height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, g.width, g.height);
      drawAxis(ctx, g, palette);
      drawMarkers(ctx, g, palette, p.markers);
      const env = p.envelopesRef.current;
      if (env && env.channels.length > 0) {
        drawTraces(ctx, g, palette, env);
        if (pointer) drawHover(ctx, g, palette, env, pointer.x, pointer.y);
      }

      total += performance.now() - t0;
      frames++;
      if (performance.now() - reported > 1000) {
        p.onFrameTime?.(total / frames);
        total = frames = 0;
        reported = performance.now();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      scheme.removeEventListener('change', onScheme);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  return <canvas ref={canvasRef} role="img" aria-label="Signal traces" className="block h-full w-full cursor-crosshair" />;
}
