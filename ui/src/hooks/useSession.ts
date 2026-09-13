import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { Session, Validation } from '../types';

/**
 * The recording lifecycle, polled once a second. Calls `onNewRecording` when a different file becomes
 * current and `onVerified` when a stopped recording finishes verifying.
 */
export function useSession({ onNewRecording, onVerified }: { onNewRecording: () => void; onVerified: (v: Validation) => void }) {
  const [session, setSession] = useState<Session | null>(null);
  const handlers = useRef({ onNewRecording, onVerified });
  handlers.current = { onNewRecording, onVerified };
  const last = useRef<{ file: string | null; state: Session['state'] | null }>({ file: null, state: null });

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await api.session();
        if (!alive) return;
        setSession(s);
        if (s.file !== last.current.file) handlers.current.onNewRecording();
        if (s.state === 'done' && last.current.state !== 'done' && s.validation) handlers.current.onVerified(s.validation);
        last.current = { file: s.file, state: s.state };
      } catch {
        // the server is restarting; try again next tick
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const start = useCallback(async () => {
    setSession((s) => (s ? { ...s, state: 'recording' } : s));
    setSession(await api.startRecording());
  }, []);

  const stop = useCallback(async () => {
    setSession((s) => (s ? { ...s, state: 'stopping' } : s));
    await api.stopRecording();
  }, []);

  return { session, start, stop };
}
