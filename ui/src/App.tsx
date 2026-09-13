import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Envelopes, FrameInfo, Meta, SeekCost, TransportState, Validation } from './types';
import { decodeFrame, fmtTime } from './lib';
import { TraceView } from './components/TraceView';
import { TransportBar } from './components/TransportBar';
import { Inspector, Segmented } from './components/Inspector';

/**
 * React owns the chrome; sample data never enters React state. Frames are PULLED from the server —
 * the next request goes out only after the last one arrived — so a slow tab asks less often rather
 * than building a backlog anywhere. Low-frequency numbers update at most four times a second.
 */

const FRAME_INTERVAL_MS = 50;

export function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(16); // how many channels to show, evenly spread
  const [windowSeconds, setWindowSeconds] = useState(10);
  const [inspector, setInspector] = useState(true);
  const [info, setInfo] = useState<FrameInfo | null>(null);
  const [transport, setTransport] = useState<TransportState | null>(null);
  const [seekCost, setSeekCost] = useState<SeekCost | null>(null);
  const [frameMs, setFrameMs] = useState(0);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [validating, setValidating] = useState(false);

  const envelopesRef = useRef<Envelopes | null>(null);
  const traceBox = useRef<HTMLDivElement | null>(null);
  // Show N channels spread evenly across the montage, so "4" means 1, 9, 17, 25 — a view of the whole
  // array — rather than the first four.
  const channels = useMemo(() => {
    if (!meta) return [];
    const n = Math.min(shown, meta.channelCount);
    const step = meta.channelCount / n;
    return Array.from({ length: n }, (_, i) => Math.floor(i * step));
  }, [meta, shown]);
  const request = useRef({ channels, windowSeconds });
  request.current = { channels, windowSeconds };

  const refreshMeta = useCallback(() => {
    return fetch('/api/meta')
      .then((r) => (r.ok ? r.json() : r.text().then((t) => Promise.reject(new Error(t)))))
      .then((m: Meta) => setMeta(m));
  }, []);

  useEffect(() => {
    refreshMeta().catch((e: Error) => setError(e.message));
  }, [refreshMeta]);

  // Markers (loss) and duration change while a recording is live; refresh them occasionally.
  useEffect(() => {
    if (!meta || meta.finalised) return;
    const t = setInterval(() => void refreshMeta().catch(() => {}), 2000);
    return () => clearInterval(t);
  }, [meta, refreshMeta]);

  // ---- the frame loop ----
  useEffect(() => {
    if (!meta) return;
    let alive = true;
    let lastState = 0;
    (async () => {
      while (alive) {
        const started = performance.now();
        const { channels: ch, windowSeconds: ws } = request.current;
        if (ch.length > 0) {
          try {
            const columns = Math.max(200, Math.min(2400, Math.floor((traceBox.current?.clientWidth ?? 1200) - 44)));
            const res = await fetch(`/api/frame?channels=${ch.join(',')}&columns=${columns}&seconds=${ws}`);
            const { info: next, envelopes } = decodeFrame(await res.arrayBuffer());
            envelopesRef.current = envelopes;
            if (performance.now() - lastState > 250) {
              lastState = performance.now();
              setInfo(next);
              setTransport(next.transport);
            }
          } catch {
            await new Promise((r) => setTimeout(r, 500)); // server gone: back off quietly
          }
        }
        const wait = FRAME_INTERVAL_MS - (performance.now() - started);
        await new Promise((r) => setTimeout(r, Math.max(0, wait)));
      }
    })();
    return () => {
      alive = false;
    };
  }, [meta]);

  const command = useCallback(async (cmd: Record<string, unknown>) => {
    const res = await fetch('/api/transport', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cmd) });
    const next = (await res.json()) as TransportState;
    setTransport(next);
    if (next.seekCost) setSeekCost(next.seekCost);
  }, []);

  const validate = useCallback(async () => {
    setValidating(true);
    try {
      setValidation(await (await fetch('/api/validate', { method: 'POST' })).json());
      await refreshMeta();
    } finally {
      setValidating(false);
    }
  }, [refreshMeta]);

  // Keyboard: Space plays or pauses, arrows skip ten seconds. Kept to three keys on purpose.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!meta || (e.target as HTMLElement).tagName === 'SELECT') return;
      const pos = transport?.position ?? 0;
      const live = (transport?.mode ?? 'live') === 'live';
      if (e.code === 'Space') {
        e.preventDefault();
        void command(live ? { op: 'mode', mode: 'review' } : { op: transport?.state === 'PLAYING' ? 'pause' : 'play' });
      } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        e.preventDefault();
        if (live) void command({ op: 'mode', mode: 'review' });
        const delta = (e.code === 'ArrowLeft' ? -10 : 10) * meta.sampleRateHz;
        void command({ op: 'seek', frame: Math.max(0, (live ? (info?.totalFrames ?? 0) : pos) + delta) });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [meta, transport, info, command]);

  const windowStart = info ? info.from / info.sampleRateHz : 0;
  const markers = useMemo(
    () => (meta?.markers ?? []).filter((m) => m.onsetSeconds < windowStart + windowSeconds && m.onsetSeconds + m.durationSeconds > windowStart),
    [meta, windowStart, windowSeconds]
  );

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md text-center">
          <div className="text-[17px] font-semibold">Can’t open this recording</div>
          <p className="mt-2 text-[13px] text-label-2">{error}</p>
        </div>
      </div>
    );
  }
  if (!meta) return <div className="flex h-full items-center justify-center text-[13px] text-label-2">Opening…</div>;

  const live = (transport?.mode ?? 'live') === 'live';
  const recording = !meta.finalised && !(info?.finalised ?? false);
  const duration = (info?.totalFrames ?? meta.totalFrames) / meta.sampleRateHz;

  return (
    <div className="flex h-full flex-col">
      {/* ---- toolbar ---- */}
      <header className="flex h-13 shrink-0 items-center gap-4 border-b border-line bg-surface/80 px-5 backdrop-blur-xl">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span className={`size-2 shrink-0 rounded-full ${recording ? 'animate-pulse bg-red' : 'bg-green'}`} />
          <span className="truncate text-[13px] font-semibold">{meta.file.replace(/\.sigb$/, '')}</span>
          <span className="shrink-0 text-[13px] text-label-2">{recording ? 'Recording' : 'Complete'}</span>
        </div>

        <div className="w-44">
          <Segmented options={['Live', 'Review']} value={live ? 'Live' : 'Review'} onChange={(v) => void command({ op: 'mode', mode: v.toLowerCase() })} />
        </div>

        <div className="flex flex-1 justify-end">
          <button
            onClick={() => setInspector(!inspector)}
            className={`flex size-8 items-center justify-center rounded-lg outline-none transition ${inspector ? 'bg-fill text-label' : 'text-label-2 hover:bg-fill'}`}
            aria-label="Toggle inspector"
            title="Inspector"
          >
            <svg width="16" height="14" viewBox="0 0 16 14" fill="none" stroke="currentColor" strokeWidth="1.4">
              <rect x="0.7" y="0.7" width="14.6" height="12.6" rx="2.5" />
              <path d="M10 1v12" />
            </svg>
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col p-4 pr-4">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-surface shadow-[0_0_0_0.5px_var(--line)]">
            <div ref={traceBox} className="min-h-0 flex-1 px-2 pt-4 pb-2">
              <TraceView
                envelopesRef={envelopesRef}
                markers={markers}
                windowStartSeconds={windowStart}
                windowSeconds={windowSeconds}
                onFrameTime={setFrameMs}
              />
            </div>
            <div className="num flex justify-between border-t border-line px-6 py-1.5 pl-[60px] text-[11px] text-label-3">
              <span>{fmtTime(windowStart, true)}</span>
              {markers.length > 0 && <span className="text-red">Samples lost in view</span>}
              <span>{fmtTime(windowStart + windowSeconds, true)}</span>
            </div>
            <div className="border-t border-line">
              <TransportBar
                transport={transport}
                durationSeconds={duration}
                sampleRateHz={meta.sampleRateHz}
                windowSeconds={windowSeconds}
                onWindowSeconds={setWindowSeconds}
                onCommand={(c) => void command(c)}
              />
            </div>
          </div>
        </main>

        {inspector && (
          <aside className="w-[320px] shrink-0 overflow-y-auto">
            <Inspector
              meta={meta}
              info={info}
              channelCount={shown}
              onChannelCount={setShown}
              validation={validation}
              validating={validating}
              onValidate={() => void validate()}
              frameMs={frameMs}
              seekCost={seekCost}
            />
          </aside>
        )}
      </div>
    </div>
  );
}
