import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EmptyMeta, Envelopes, FrameInfo, Meta, SeekCost, Session, TransportState, Validation } from './types';
import { decodeFrame, fmtInt, fmtTime } from './lib';
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
  const [meta, setMeta] = useState<Meta | EmptyMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
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
  const recording = meta && !meta.empty ? meta : null;

  // Show N channels spread evenly across the montage, so "4" means 1, 9, 17, 25 — a view of the whole
  // array — rather than the first four.
  const channels = useMemo(() => {
    if (!recording) return [];
    const n = Math.min(shown, recording.channelCount);
    const step = recording.channelCount / n;
    return Array.from({ length: n }, (_, i) => Math.floor(i * step));
  }, [recording, shown]);
  const request = useRef({ channels, windowSeconds });
  request.current = { channels, windowSeconds };

  const refreshMeta = useCallback(() => {
    return fetch('/api/meta')
      .then((r) => (r.ok ? r.json() : r.text().then((t) => Promise.reject(new Error(t)))))
      .then((m: Meta | EmptyMeta) => setMeta(m));
  }, []);

  useEffect(() => {
    refreshMeta().catch((e: Error) => setError(e.message));
  }, [refreshMeta]);

  // ---- session: poll once a second; react to a new file and to a finished verification ----
  const lastFile = useRef<string | null>(null);
  const lastState = useRef<Session['state'] | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = (await (await fetch('/api/session')).json()) as Session;
        if (!alive) return;
        setSession(s);
        if (s.file !== lastFile.current) {
          lastFile.current = s.file;
          envelopesRef.current = null;
          setInfo(null);
          setValidation(null);
          await refreshMeta();
        }
        if (s.state !== lastState.current) {
          lastState.current = s.state;
          if (s.state === 'done') {
            await refreshMeta();
            if (s.validation) setValidation(s.validation);
          }
        }
      } catch {
        /* server restarting; try again next tick */
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [refreshMeta]);

  // Loss markers and duration change while a recording is open; refresh them occasionally.
  useEffect(() => {
    if (!recording || recording.finalised) return;
    const t = setInterval(() => void refreshMeta().catch(() => {}), 2000);
    return () => clearInterval(t);
  }, [recording, refreshMeta]);

  // ---- the frame loop ----
  const hasRecording = !!recording;
  useEffect(() => {
    if (!hasRecording) return;
    let alive = true;
    let lastUpdate = 0;
    (async () => {
      while (alive) {
        const started = performance.now();
        const { channels: ch, windowSeconds: ws } = request.current;
        if (ch.length > 0) {
          try {
            const columns = Math.max(200, Math.min(2400, Math.floor((traceBox.current?.clientWidth ?? 1200) - 44)));
            const res = await fetch(`/api/frame?channels=${ch.join(',')}&columns=${columns}&seconds=${ws}`);
            if (res.status === 200) {
              const { info: next, envelopes } = decodeFrame(await res.arrayBuffer());
              envelopesRef.current = envelopes;
              if (performance.now() - lastUpdate > 250) {
                lastUpdate = performance.now();
                setInfo(next);
                setTransport(next.transport);
              }
            }
          } catch {
            await new Promise((r) => setTimeout(r, 500));
          }
        }
        const wait = FRAME_INTERVAL_MS - (performance.now() - started);
        await new Promise((r) => setTimeout(r, Math.max(0, wait)));
      }
    })();
    return () => {
      alive = false;
    };
  }, [hasRecording]);

  const command = useCallback(async (cmd: Record<string, unknown>) => {
    const res = await fetch('/api/transport', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cmd) });
    if (!res.ok) return;
    const next = (await res.json()) as TransportState;
    setTransport(next);
    if (next.seekCost) setSeekCost(next.seekCost);
  }, []);

  const startRecording = useCallback(async () => {
    setSession((s) => (s ? { ...s, state: 'recording' } : s));
    const s = (await (await fetch('/api/session/start', { method: 'POST' })).json()) as Session;
    setSession(s);
  }, []);

  const stopRecording = useCallback(async () => {
    setSession((s) => (s ? { ...s, state: 'stopping' } : s));
    await fetch('/api/session/stop', { method: 'POST' });
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

  // Keyboard: Space plays or pauses, arrows skip ten seconds.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!recording || (e.target as HTMLElement).tagName === 'SELECT') return;
      const pos = transport?.position ?? 0;
      const live = (transport?.mode ?? 'live') === 'live';
      if (e.code === 'Space') {
        e.preventDefault();
        void command(live ? { op: 'mode', mode: 'review' } : { op: transport?.state === 'PLAYING' ? 'pause' : 'play' });
      } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        e.preventDefault();
        if (live) void command({ op: 'mode', mode: 'review' });
        const delta = (e.code === 'ArrowLeft' ? -10 : 10) * recording.sampleRateHz;
        void command({ op: 'seek', frame: Math.max(0, (live ? (info?.totalFrames ?? 0) : pos) + delta) });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [recording, transport, info, command]);

  const windowStart = info ? info.from / info.sampleRateHz : 0;
  const markers = useMemo(
    () =>
      (recording?.markers ?? []).filter(
        (m) => m.onsetSeconds < windowStart + windowSeconds && m.onsetSeconds + m.durationSeconds > windowStart
      ),
    [recording, windowStart, windowSeconds]
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

  const state = session?.state ?? (recording ? 'done' : 'idle');
  const busy = state === 'stopping' || state === 'verifying';
  const duration = recording ? (info?.totalFrames ?? recording.totalFrames) / recording.sampleRateHz : 0;
  const status =
    state === 'recording' ? 'Recording' : state === 'stopping' ? 'Saving…' : state === 'verifying' ? 'Verifying…' : recording?.finalised ? 'Saved' : '';

  return (
    <div className="flex h-full flex-col">
      {/* ---- toolbar ---- */}
      <header className="flex h-13 shrink-0 items-center gap-4 border-b border-line bg-surface/80 px-5 backdrop-blur-xl">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          {recording ? (
            <>
              <span className="truncate text-[13px] font-semibold">{recording.file.replace(/\.sigb$/, '')}</span>
              <span className="shrink-0 text-[13px] text-label-2">{status}</span>
            </>
          ) : (
            <span className="text-[13px] font-semibold">sigacq</span>
          )}
        </div>

        {recording && (
          <div className="w-44">
            <Segmented
              options={['Live', 'Review']}
              value={(transport?.mode ?? 'live') === 'live' ? 'Live' : 'Review'}
              onChange={(v) => void command({ op: 'mode', mode: v.toLowerCase() })}
            />
          </div>
        )}

        <div className="flex flex-1 items-center justify-end gap-2">
          <RecordButton state={state} seconds={duration} onStart={() => void startRecording()} onStop={() => void stopRecording()} />
          {recording && (
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
          )}
        </div>
      </header>

      {!recording ? (
        <EmptyState meta={meta as EmptyMeta} busy={state === 'recording'} error={session?.error ?? null} onStart={() => void startRecording()} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <main className="flex min-w-0 flex-1 flex-col p-4">
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
                  sampleRateHz={recording.sampleRateHz}
                  windowSeconds={windowSeconds}
                  onWindowSeconds={setWindowSeconds}
                  onCommand={(c) => void command(c)}
                />
              </div>
            </div>
          </main>

          {inspector && (
            <aside className="w-[320px] shrink-0 overflow-y-auto">
              {session?.error && <p className="mx-5 mt-6 rounded-xl bg-surface px-4 py-3 text-[13px] text-red">{session.error}</p>}
              <Inspector
                meta={recording}
                info={info}
                channelCount={shown}
                onChannelCount={setShown}
                validation={validation}
                validating={validating || state === 'verifying'}
                onValidate={() => void validate()}
                verifyDisabled={busy || state === 'recording'}
                frameMs={frameMs}
                seekCost={seekCost}
              />
            </aside>
          )}
        </div>
      )}
    </div>
  );
}

/** One control for the whole recording lifecycle, the way a media app does it. */
function RecordButton(p: { state: Session['state']; seconds: number; onStart: () => void; onStop: () => void }) {
  if (p.state === 'recording') {
    return (
      <button
        onClick={p.onStop}
        className="num flex h-8 items-center gap-2 rounded-full bg-fill pr-3.5 pl-2.5 text-[13px] font-medium outline-none transition hover:bg-fill-strong"
        title="Stop and verify"
      >
        <span className="size-2.5 rounded-[3px] bg-red" />
        Stop
        <span className="text-label-2">{fmtTime(p.seconds)}</span>
      </button>
    );
  }
  if (p.state === 'stopping' || p.state === 'verifying') {
    return (
      <span className="flex h-8 items-center gap-2 rounded-full bg-fill px-3.5 text-[13px] text-label-2">
        <span className="size-2 animate-pulse rounded-full bg-label-3" />
        {p.state === 'stopping' ? 'Saving' : 'Verifying'}
      </span>
    );
  }
  return (
    <button
      onClick={p.onStart}
      className="flex h-8 items-center gap-2 rounded-full bg-fill pr-3.5 pl-2.5 text-[13px] font-medium outline-none transition hover:bg-fill-strong"
      title="Start a new recording"
    >
      <span className="size-2.5 rounded-full bg-red" />
      Record
    </button>
  );
}

function EmptyState(p: { meta: EmptyMeta; busy: boolean; error: string | null; onStart: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="flex max-w-sm flex-col items-center text-center">
        <button
          onClick={p.onStart}
          disabled={p.busy}
          aria-label="Start recording"
          className="group flex size-20 items-center justify-center rounded-full bg-surface shadow-[0_0_0_0.5px_var(--line),0_4px_16px_rgba(0,0,0,0.06)] outline-none transition active:scale-95 disabled:opacity-60"
        >
          <span className="size-8 rounded-full bg-red transition group-hover:scale-105" />
        </button>
        <h1 className="mt-6 text-[22px] font-semibold tracking-tight">{p.busy ? 'Starting…' : 'Ready to record'}</h1>
        <p className="num mt-1.5 text-[13px] text-label-2">
          {p.meta.channelCount} channels · {fmtInt(p.meta.sampleRateHz)} Hz · {fmtInt(p.meta.channelCount * p.meta.sampleRateHz)} samples per second
        </p>
        <p className="mt-4 text-[13px] leading-relaxed text-label-2">
          A generator process streams a known signal to a separate recorder, which writes every sample to disk.
          Stop whenever you like; the recording is checked sample by sample as soon as it is saved.
        </p>
        {p.error && <p className="mt-4 text-[13px] text-red">{p.error}</p>}
      </div>
    </div>
  );
}
