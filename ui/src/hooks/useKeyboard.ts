import { useEffect, useRef } from 'react';

/** Space plays or pauses; arrow keys skip ten seconds. Ignored while typing in a form control. */
export function useKeyboard({ enabled, onPlayPause, onSkip }: { enabled: boolean; onPlayPause: () => void; onSkip: (seconds: number) => void }) {
  const handlers = useRef({ onPlayPause, onSkip });
  handlers.current = { onPlayPause, onSkip };

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'SELECT' || tag === 'INPUT' || tag === 'BUTTON' || e.metaKey || e.ctrlKey) return;
      if (e.code === 'Space') handlers.current.onPlayPause();
      else if (e.code === 'ArrowLeft') handlers.current.onSkip(-10);
      else if (e.code === 'ArrowRight') handlers.current.onSkip(10);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
