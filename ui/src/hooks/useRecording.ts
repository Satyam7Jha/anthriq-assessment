import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { EmptyMeta, Meta } from '../types';

/** The current recording's metadata, refreshed while it is still being written. */
export function useRecording() {
  const [meta, setMeta] = useState<Meta | EmptyMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => api.meta().then(setMeta), []);

  useEffect(() => {
    refresh().catch((e: Error) => setError(e.message));
  }, [refresh]);

  const open = meta && !meta.empty && !meta.finalised;
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => void refresh().catch(() => {}), 2000);
    return () => clearInterval(t);
  }, [open, refresh]);

  return { meta, recording: meta && !meta.empty ? meta : null, error, refresh };
}
