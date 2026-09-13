import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { Envelopes, FrameInfo } from '../types';
import { GUTTER } from '../features/trace/TraceView';

const FRAME_INTERVAL_MS = 50;
const STATE_INTERVAL_MS = 250;

/**
 * Pulls decimated frames from the server. The next request goes out only after the last one arrived,
 * so a slow tab asks less often instead of building a backlog. Pixel data goes into a ref, never into
 * React state; the numbers people read update at most four times a second.
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
        const { channels: ch, windowSeconds: seconds } = request.current;
        if (ch.length > 0) {
          try {
            const columns = Math.max(200, Math.min(2400, Math.floor((widthRef.current?.clientWidth ?? 1200) - GUTTER)));
            const frame = await api.frame({ channels: ch, columns, seconds });
            if (frame) {
              envelopesRef.current = frame.envelopes;
              if (performance.now() - lastState > STATE_INTERVAL_MS) {
                lastState = performance.now();
                setInfo(frame.info);
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
