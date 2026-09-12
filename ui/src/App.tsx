import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Envelopes, Meta, TransportState, WindowPayload, ChannelQuality } from './types';
import { decodeEnvelopes, fmtBytes, fmtClock, fmtInt } from './lib';
import { TraceStack } from './components/TraceStack';
import { MontagePicker } from './components/MontagePicker';
import { HealthPanel } from './components/HealthPanel';
import { QualityStrip } from './components/QualityStrip';
import { Transport } from './components/Transport';

/**
 * React's role here is deliberately narrow: it owns CHROME AND STATE — channel selection, time base,
 * gains, transport — and never touches pixel data. Sample data lives in `envelopesRef`, outside the
 * render cycle entirely, and the canvas reads it from a requestAnimationFrame loop.
 *
 * That split is the whole performance argument. Pushing 32 channels × 2,000 floats through setState
 * at 20 Hz would reconcile the tree 20 times a second and hand React 2.5 MB/s of garbage, for a
 * picture that is identical to the one the canvas draws for free.
 *
 * The low-frequency slice of each payload — transport position, recorder health, byte counts — DOES
 * go through state, because it changes rarely enough that re-rendering a few text nodes is the
 * simplest correct thing.
 */

const ROW_HEIGHTS = [16, 24, 32, 48, 72, 110];

export function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [channels, setChannels] = useState<number[]>([]);
  const [secondsPerScreen, setSecondsPerScreen] = useState(10);
  const [rowHeight, setRowHeight] = useState(32);
  const [amplitudeScale, setAmplitudeScale] = useState(2.5);
  const [useMontage, setUseMontage] = useState(false);
  const [gains, setGains] = useState<Record<number, number>>({});
  const [connected, setConnected] = useState(false);
  const [transport, setTransport] = useState<TransportState | null>(null);
  // Seek cost lives in its own state deliberately. It is a one-shot measurement returned by the POST,
  // and the 20 Hz stream's transport snapshot does not carry it — folding it into `transport` would
  // mean the number flashes up and is wiped 250 ms later, which is worse than not showing it.
  const [seekCost, setSeekCost] = useState<TransportState['seekCost'] | null>(null);
  const [quality, setQuality] = useState<Record<string, ChannelQuality>>({});
  const [lowFreq, setLowFreq] = useState<{
    windowFrom: number;
    bytesRead: number;
    allChannelBytes: number;
    predictedBytes: number;
    totalFrames: number;
    recorder: WindowPayload['recorder'];
  }>({ windowFrom: 0, bytesRead: 0, allChannelBytes: 0, predictedBytes: 0, totalFrames: 0, recorder: null });
  const [fps, setFps] = useState(0);
  const [frameMs, setFrameMs] = useState(0);
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<Parameters<typeof HealthPanel>[0]['validation']>(null);

  // --- the data path that bypasses React entirely ---
  const envelopesRef = useRef<Envelopes>(new Map());
  const windowSecondsRef = useRef(secondsPerScreen);
  windowSecondsRef.current = secondsPerScreen;

  // Throttle the low-frequency state updates to ~4 Hz. The SSE stream arrives at 20 Hz, but numbers
  // a human reads do not need to update 20 times a second, and each update is a full re-render.
  const lastStateUpdate = useRef(0);

  useEffect(() => {
    fetch('/api/meta')
      .then((r) => (r.ok ? r.json() : r.text().then((t) => Promise.reject(new Error(t)))))
      .then((m: Meta) => {
        setMeta(m);
        setChannels(Array.from({ length: Math.min(m.channelCount, 32) }, (_, i) => i));
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  // --- SSE subscription -------------------------------------------------------------------------
  useEffect(() => {
    if (!meta || channels.length === 0) return;
    const columns = Math.max(200, Math.min(2000, Math.floor(window.innerWidth - 420)));
    const qs = new URLSearchParams({
      channels: channels.join(','),
      columns: String(columns),
      seconds: String(secondsPerScreen),
    });
    const es = new EventSource(`/api/stream?${qs}`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (ev) => {
      const payload = JSON.parse(ev.data) as WindowPayload;
      // Pixel data: straight into the ref, never into state.
      decodeEnvelopes(payload, envelopesRef.current);
      const now = performance.now();
      if (now - lastStateUpdate.current < 250) return;
      lastStateUpdate.current = now;
      setTransport(payload.transport);
      setQuality(payload.quality);
      setLowFreq({
        windowFrom: payload.from,
        bytesRead: payload.bytesRead,
        allChannelBytes: payload.allChannelBytes,
        predictedBytes: payload.predictedBytes,
        totalFrames: payload.totalFrames,
        recorder: payload.recorder ?? null,
      });
    };
    return () => es.close();
  }, [meta, channels, secondsPerScreen]);

  const command = useCallback(async (cmd: Record<string, unknown>) => {
    const res = await fetch('/api/transport', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cmd),
    });
    const next = (await res.json()) as TransportState;
    setTransport(next);
    if (next.seekCost) setSeekCost(next.seekCost);
  }, []);

  const runValidator = useCallback(async () => {
    setValidating(true);
    try {
      const res = await fetch('/api/validate', { method: 'POST' });
      setValidation(await res.json());
    } finally {
      setValidating(false);
    }
  }, []);

  // Which selected channels intersect a gap in the visible window. A gap is the one quality
  // indicator that is a SYSTEM fault rather than a sensor fault, so it is derived from the ledger
  // rather than from the samples.
  const windowFromSeconds = meta ? lowFreq.windowFrom / meta.sampleRateHz : 0;
  const gapChannels = useMemo(() => {
    const set = new Set<number>();
    if (!meta) return set;
    const to = windowFromSeconds + secondsPerScreen;
    const hit = meta.markers.some(
      (m) => m.onsetSeconds < to && m.onsetSeconds + m.durationSeconds > windowFromSeconds
    );
    if (hit) for (const c of channels) set.add(c); // a dropped frame loses every channel at once
    return set;
  }, [meta, windowFromSeconds, secondsPerScreen, channels]);

  const visibleMarkers = useMemo(() => {
    if (!meta) return [];
    const to = windowFromSeconds + secondsPerScreen;
    return meta.markers.filter((m) => m.onsetSeconds < to && m.onsetSeconds + m.durationSeconds > windowFromSeconds);
  }, [meta, windowFromSeconds, secondsPerScreen]);

  const onFps = useCallback((f: number, ms: number) => {
    setFps(f);
    setFrameMs(ms);
  }, []);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-lg rounded-lg border border-red-500/40 bg-red-500/5 p-5">
          <h1 className="mb-2 text-sm font-semibold text-red-300">Cannot open the recording</h1>
          <pre className="whitespace-pre-wrap text-xs text-slate-300">{error}</pre>
        </div>
      </div>
    );
  }
  if (!meta) {
    return <div className="flex h-full items-center justify-center text-sm text-slate-500">loading recording…</div>;
  }

  // In LIVE mode the cursor is the live edge — the most recently committed frame — not the playback
  // cursor, which only advances while PLAYING. Showing a frozen 00:00:00 next to a scrolling trace
  // would be actively misleading.
  const liveEdge = lowFreq.totalFrames;
  const position = (transport?.mode ?? 'live') === 'live' ? liveEdge : (transport?.position ?? 0);

  return (
    <div className="flex h-full flex-col">
      {/* ---- header ---- */}
      <header className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-slate-800 bg-slate-900/80 px-4 py-2">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block size-2 rounded-full ${
              !connected ? 'bg-slate-600' : meta.finalised ? 'bg-emerald-400' : 'animate-pulse bg-red-500'
            }`}
            title={connected ? (meta.finalised ? 'completed recording' : 'live — file is still being written') : 'disconnected'}
          />
          <span className="text-sm font-semibold tracking-tight text-slate-100">{meta.file}</span>
          {!meta.finalised && (
            <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-300">
              recording
            </span>
          )}
        </div>
        <dl className="num flex flex-wrap items-baseline gap-x-5 gap-y-0.5 text-[11px] text-slate-400">
          <Stat label="montage">{meta.channelCount} ch</Stat>
          <Stat label="rate">{fmtInt(meta.sampleRateHz)} Hz</Stat>
          <Stat label="aggregate">{fmtInt(meta.channelCount * meta.sampleRateHz)} values/s</Stat>
          <Stat label="duration">{fmtClock(lowFreq.totalFrames / meta.sampleRateHz || meta.durationSeconds)}</Stat>
          <Stat label="samples">{fmtInt(lowFreq.totalFrames * meta.channelCount || meta.totalValues)}</Stat>
          <Stat label="size">{fmtBytes(meta.fileSizeBytes)}</Stat>
          <Stat label="cursor">{fmtClock(position / meta.sampleRateHz)}</Stat>
        </dl>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ---- trace stack ---- */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 overflow-y-auto">
            <div className="min-w-0 flex-1">
              <TraceStack
                envelopesRef={envelopesRef}
                channels={channels}
                gains={gains}
                offsets={{}}
                rowHeight={rowHeight}
                amplitudeScale={amplitudeScale}
                channelCount={meta.channelCount}
                useMontage={useMontage}
                markers={visibleMarkers}
                windowFromSeconds={windowFromSeconds}
                windowSecondsRef={windowSecondsRef}
                onFps={onFps}
              />
            </div>
            <QualityStrip
              meta={meta}
              channels={channels}
              quality={quality}
              gapChannels={gapChannels}
              useMontage={useMontage}
              rowHeight={rowHeight}
            />
          </div>

          {/* time axis */}
          <div className="num flex justify-between border-t border-slate-800 px-4 py-1 text-[10px] text-slate-500">
            <span>{fmtClock(windowFromSeconds)}</span>
            <span>
              {visibleMarkers.length > 0 && (
                <span className="text-red-400">
                  ▲ {visibleMarkers.length} gap{visibleMarkers.length === 1 ? '' : 's'} in view
                </span>
              )}
            </span>
            <span>{fmtClock(windowFromSeconds + secondsPerScreen)}</span>
          </div>

          <Transport
            meta={meta}
            transport={transport}
            mode={transport?.mode ?? 'live'}
            secondsPerScreen={secondsPerScreen}
            onSecondsPerScreen={setSecondsPerScreen}
            onCommand={command}
            positionFrames={position}
            seekCost={seekCost}
          />
        </main>

        {/* ---- side panel ---- */}
        <aside className="w-80 shrink-0 space-y-5 overflow-y-auto border-l border-slate-800 bg-slate-900/40 p-4">
          <MontagePicker
            meta={meta}
            selected={channels}
            onChange={setChannels}
            useMontage={useMontage}
            onToggleMontage={setUseMontage}
            measuredBytes={lowFreq.bytesRead}
            allChannelBytes={lowFreq.allChannelBytes}
            predictedBytes={lowFreq.predictedBytes}
          />

          <section>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-400">Display</h3>
            <label className="mb-2 block text-[10px] text-slate-500">
              row height
              <div className="mt-1 flex gap-1">
                {ROW_HEIGHTS.map((h) => (
                  <button
                    key={h}
                    onClick={() => setRowHeight(h)}
                    className={`num flex-1 rounded px-1 py-0.5 text-[10px] transition ${
                      rowHeight === h
                        ? 'bg-cyan-500/20 text-cyan-300 ring-1 ring-inset ring-cyan-500/40'
                        : 'text-slate-400 hover:bg-slate-800'
                    }`}
                  >
                    {h}
                  </button>
                ))}
              </div>
            </label>
            <label className="block text-[10px] text-slate-500">
              amplitude scale — <span className="num text-slate-300">±{amplitudeScale.toFixed(2)} units/row</span>
              <input
                type="range"
                min={0.25}
                max={8}
                step={0.05}
                value={amplitudeScale}
                onChange={(e) => setAmplitudeScale(Number(e.target.value))}
                className="mt-1 w-full accent-cyan-400"
              />
            </label>
            <p className="mt-1 text-[10px] leading-relaxed text-slate-600">
              Units are dimensionless: the source is a synthetic function, not an ADC. With a real
              front end this axis would read µV/div and the header would carry Vref and per-channel
              gain.
            </p>
            <button
              onClick={() => setGains(Object.fromEntries(channels.map((c) => [c, 1])))}
              className="mt-2 w-full rounded border border-slate-700 px-2 py-1 text-[10px] text-slate-400 transition hover:border-slate-600 hover:text-slate-200"
            >
              reset per-channel gains
            </button>
          </section>

          <HealthPanel
            health={lowFreq.recorder}
            meta={meta}
            fps={fps}
            frameMs={frameMs}
            pushBytes={lowFreq.bytesRead}
            allChannelBytes={lowFreq.allChannelBytes}
            onValidate={runValidator}
            validating={validating}
            validation={validation}
          />

          <section className="border-t border-slate-800 pt-3 text-[10px] leading-relaxed text-slate-600">
            <p className="mb-1">
              <span className="text-slate-400">Read-only viewer.</span> This process opens the
              recording <code className="text-slate-400">O_RDONLY</code> and never connects to the
              recorder, so it has no channel through which to slow acquisition down.
            </p>
            <p>
              Display latency is ~1.1 s by design: the view follows committed file blocks rather than
              the live socket.
            </p>
            <p className="mt-1 num text-slate-700">
              {meta.signalId} · {meta.dtype} · {meta.layout}
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-[10px] uppercase tracking-wider text-slate-600">{label}</dt>
      <dd className="text-slate-300">{children}</dd>
    </div>
  );
}
