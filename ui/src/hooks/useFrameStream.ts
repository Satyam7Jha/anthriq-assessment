import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { Envelopes, FrameInfo } from '../types';
import { GUTTER, TRACE_PAD_SECONDS } from '../features/trace/TraceView';

const FRAME_INTERVAL_MS = 50;
const STATE_INTERVAL_MS = 250;
const MAX_COLUMNS = 4096;

/**
 * Pulls decimated frames from the server. The next request goes out only after the last one arrived,
 * so a slow tab asks less often instead of building a backlog. Each request covers the visible window
 * plus TRACE_PAD_SECONDS, at about one column per pixel, so the trace view can glide between frames.
 * Pixel data goes into a ref, never into React state; the numbers people read update at most four
 * times a second.
 */
export function useFrameStream({ enabled, channels, windowSeconds, widthRef }: { enabled: boolean; channels: number[]; windowSeconds: number; widthRef: React.RefObject<HTMLElement | null> }) {
  const envelopesRef = useRef<Envelopes | null>(null);
  const [info, setInfo] = useState<FrameInfo | null>(null);
  const request = useRef({ channels, windowSeconds });
  request.current = { channels, windowSeconds };

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let lastState = 0;
    (async () => {
      while (alive) {
        const started = performance.now();
        const { channels: ch, windowSeconds: visible } = request.current;
        if (ch.length > 0) {
          try {
            const seconds = visible + TRACE_PAD_SECONDS;
            const plotWidth = Math.max(200, (widthRef.current?.clientWidth ?? 1200) - GUTTER);
            const columns = Math.min(MAX_COLUMNS, Math.round((plotWidth * seconds) / visible));
            const frame = await api.frame({ channels: ch, columns, seconds });
            if (frame) {
              const { info: fi } = frame;
              envelopesRef.current = {
                ...frame.envelopes,
                fromSeconds: fi.from / fi.sampleRateHz,
                columnSeconds: fi.samplesPerColumn / fi.sampleRateHz,
                endSeconds: fi.endFrame / fi.sampleRateHz,
                sampleRateHz: fi.sampleRateHz,
                transport: fi.transport,
                finalised: fi.finalised,
                receivedAt: performance.now(),
              };
              if (performance.now() - lastState > STATE_INTERVAL_MS) {
                lastState = performance.now();
                setInfo(fi);
              }
            }
          } catch {
            await new Promise((r) => setTimeout(r, 500));
          }
        }
        await new Promise((r) => setTimeout(r, Math.max(0, FRAME_INTERVAL_MS - (performance.now() - started))));
      }
    })();
    return () => {
      alive = false;
    };
  }, [enabled, widthRef]);

  const reset = () => {
    envelopesRef.current = null;
    setInfo(null);
  };

  return { envelopesRef, info, reset };
}
