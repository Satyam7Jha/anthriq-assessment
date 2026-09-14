import { useCallback, useMemo, useRef, useState } from 'react';
import type { EmptyMeta, FrameInfo, Marker, Validation } from '../types';
import { api } from '../api/client';
import { useRecording } from '../hooks/useRecording';
import { useSession } from '../hooks/useSession';
import { useFrameStream } from '../hooks/useFrameStream';
import { usePlayback } from '../hooks/usePlayback';
import { useKeyboard } from '../hooks/useKeyboard';
import { Toolbar } from '../features/recording/Toolbar';
import { EmptyState } from '../features/recording/EmptyState';
import { RecordingBanner } from '../features/recording/RecordingBanner';
import { StatsStrip } from '../features/overview/StatsStrip';
import { TraceView } from '../features/trace/TraceView';
import { TransportBar } from '../features/transport/TransportBar';
import { Inspector } from '../features/inspector/Inspector';

const NO_MARKERS: Marker[] = [];

/** Where the visible window starts, by the same rule the server and the trace view use: live follows the end, review centres the cursor. */
function visibleStart(info: FrameInfo, windowSeconds: number): number {
  const end = info.endFrame / info.sampleRateHz;
  if (info.transport.mode === 'live') return Math.max(0, end - windowSeconds);
  return Math.max(0, Math.min(info.transport.position / info.sampleRateHz - windowSeconds / 2, end - windowSeconds));
}

/** Composition only: state lives in hooks, controls in features, visual primitives in components/ui. */
export function App() {
  const [windowSeconds, setWindowSeconds] = useState(10);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [validating, setValidating] = useState(false);
  const [frameMs, setFrameMs] = useState(0);
  const traceBox = useRef<HTMLDivElement | null>(null);

  const { meta, recording, error, refresh } = useRecording();

  // Every channel, always.
  const channels = useMemo(() => (recording ? Array.from({ length: recording.channelCount }, (_, i) => i) : []), [recording]);

  const frames = useFrameStream({ enabled: !!recording, channels, windowSeconds, widthRef: traceBox });
  const { session, start, stop } = useSession({
    onNewRecording: () => {
      frames.reset();
      setValidation(null);
      void refresh();
    },
    onVerified: (v) => {
      setValidation(v);
      void refresh();
    },
  });

  const state = session?.state ?? (recording ? 'done' : 'idle');
  const recordingOpen = state === 'recording' || (!!recording && !recording.finalised && state !== 'done');
  const playback = usePlayback({ recording, info: frames.info, recordingOpen, windowSeconds });
  useKeyboard({ enabled: !!recording, onPlayPause: playback.playPause, onSkip: playback.skip });

  const verify = useCallback(async () => {
    setValidating(true);
    try {
      setValidation(await api.validate());
      await refresh();
    } finally {
      setValidating(false);
    }
  }, [refresh]);

  if (error) {
    return (
      <div role="alert" className="flex h-full items-center justify-center p-8 text-center">
        <div>
          <h1 className="text-[17px] font-semibold">Can’t open this recording</h1>
          <p className="mt-2 text-[13px] text-label-2">{error}</p>
        </div>
      </div>
    );
  }
  if (!meta) return <div className="flex h-full items-center justify-center text-[13px] text-label-2">Opening…</div>;

  // The timeline runs to the last frame index, so gaps (a sleep, a stalled disk) take real space on it.
  const duration = recording ? (frames.info?.endFrame ?? recording.endFrame) / recording.sampleRateHz : 0;
  const windowStart = frames.info ? visibleStart(frames.info, windowSeconds) : 0;
  const markers = recording?.markers ?? NO_MARKERS;
  const onStart = () => void start();
  const onStop = () => void stop();

  return (
    <div className="flex h-full flex-col bg-bg">
      <Toolbar recording={recording} state={state} seconds={duration} inspectorOpen={inspectorOpen} onToggleInspector={() => setInspectorOpen(!inspectorOpen)} onStart={onStart} onStop={onStop} />

      {!recording ? (
        <EmptyState meta={meta as EmptyMeta} starting={state === 'recording'} error={session?.error ?? null} onStart={onStart} />
      ) : (
        <>
          <StatsStrip meta={recording} info={frames.info} state={state} validation={validation} limitSeconds={meta.limits.maxRecordingSeconds} />
          <div className="flex min-h-0 flex-1">
            <main className="flex min-w-0 flex-1 flex-col">
              <RecordingBanner state={state} />
              <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-5 py-3">
                <h2 className="text-[15px] font-semibold">Signal</h2>
                <span className="num text-[13px] text-label-2">
                  All {recording.channelCount} channels · each row scaled to its own range · hover for values
                </span>
              </div>
              <div ref={traceBox} className="min-h-0 flex-1 px-3 pt-3 pb-1">
                <TraceView envelopesRef={frames.envelopesRef} markers={markers} windowSeconds={windowSeconds} onFrameTime={setFrameMs} />
              </div>
              <div className="shrink-0 border-t border-line">
                <TransportBar playback={playback} durationSeconds={duration} windowSeconds={windowSeconds} onWindowSeconds={setWindowSeconds} />
              </div>
            </main>

            {inspectorOpen && (
              <aside aria-label="Details" className="w-[380px] shrink-0 overflow-y-auto border-l border-line">
                {session?.error && (
                  <p role="alert" className="border-b border-line bg-red-soft px-5 py-3 text-[13px] text-red">
                    {session.error}
                  </p>
                )}
                <Inspector
                  meta={recording}
                  info={frames.info}
                  channels={channels}
                  windowStart={windowStart}
                  windowSeconds={windowSeconds}
                  validation={validation}
                  validating={validating || state === 'verifying'}
                  recordingInProgress={state === 'recording' || state === 'stopping'}
                  onVerify={() => void verify()}
                  frameMs={frameMs}
                  seekCost={playback.seekCost}
                />
              </aside>
            )}
          </div>
        </>
      )}
    </div>
  );
}
