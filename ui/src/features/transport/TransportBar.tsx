import { IconButton, Select, Button } from '../../components/ui';
import { fmtTime } from '../../lib/format';
import type { Playback } from '../../hooks/usePlayback';

/**
 * Behaves like a media player: an open recording is a live stream ("Live", pause freezes it, drag back
 * in time, "Go live" returns); a finished recording is a video. Section 3 of the brief lives here.
 */

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8].map((s) => ({ value: String(s), label: `${s}×` }));
const WINDOWS = [2, 5, 10, 30, 60].map((s) => ({ value: String(s), label: `${s} s` }));

export interface TransportBarProps {
  playback: Playback;
  durationSeconds: number;
  windowSeconds: number;
  onWindowSeconds: (seconds: number) => void;
}

export function TransportBar({ playback: p, durationSeconds, windowSeconds, onWindowSeconds }: TransportBarProps) {
  const position = p.isLive ? durationSeconds : p.positionSeconds;
  const pct = durationSeconds > 0 ? (position / durationSeconds) * 100 : 0;
  const showLive = p.isLive && p.recordingOpen;

  return (
    <div className="flex items-center gap-4 px-5 py-3">
      <IconButton size="lg" label={p.playing ? 'Pause' : 'Play'} onClick={p.playPause}>
        {p.playing ? (
          <svg aria-hidden width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="1" width="3" height="10" rx="1" /><rect x="7" y="1" width="3" height="10" rx="1" /></svg>
        ) : (
          <svg aria-hidden width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M3 1.6v8.8a.6.6 0 0 0 .9.5l7-4.4a.6.6 0 0 0 0-1L3.9 1.1a.6.6 0 0 0-.9.5z" /></svg>
        )}
      </IconButton>

      <span className="num w-14 shrink-0 text-right text-[13px]" aria-live="off">
        {showLive ? (
          <span className="inline-flex items-center gap-1.5 font-medium text-red">
            <span className="size-1.5 rounded-full bg-red" />
            Live
          </span>
        ) : (
          fmtTime(position)
        )}
      </span>

      <input
        type="range"
        min={0}
        max={Math.max(1, Math.floor(durationSeconds * p.sampleRateHz))}
        value={Math.floor(position * p.sampleRateHz)}
        onChange={(e) => p.seek(Number(e.target.value))}
        style={{ '--pct': `${pct}%` } as React.CSSProperties}
        className="min-w-0 flex-1"
        aria-label="Position"
        aria-valuetext={fmtTime(position)}
      />

      <span className="num w-14 shrink-0 text-[13px] text-label-2">{fmtTime(durationSeconds)}</span>

      {!p.isLive && p.recordingOpen && (
        <Button className="h-7 text-red" onClick={p.goLive}>
          <span className="size-1.5 rounded-full bg-red" />
          Go live
        </Button>
      )}
      {!p.isLive && <Select label="Speed" value={String(p.rate)} options={SPEEDS} onChange={(v) => p.setRate(Number(v))} />}
      <Select label="Window" value={String(windowSeconds)} options={WINDOWS} onChange={(v) => onWindowSeconds(Number(v))} />
    </div>
  );
}
