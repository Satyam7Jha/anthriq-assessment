import type { TransportState } from '../types';
import { fmtTime } from '../lib';

/**
 * One quiet bar: play, time, scrubber, speed, window. Everything a reviewer needs to move through a
 * recording, nothing else. Section 3 of the brief (pause, resume, seek, variable rate) lives here.
 */

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];
const WINDOWS = [2, 5, 10, 30, 60];

export interface TransportBarProps {
  transport: TransportState | null;
  durationSeconds: number;
  sampleRateHz: number;
  windowSeconds: number;
  onWindowSeconds: (s: number) => void;
  onCommand: (cmd: Record<string, unknown>) => void;
}

export function TransportBar(p: TransportBarProps) {
  const live = (p.transport?.mode ?? 'live') === 'live';
  const playing = p.transport?.state === 'PLAYING';
  const position = (p.transport?.position ?? 0) / p.sampleRateHz;
  const shown = live ? p.durationSeconds : position;
  const pct = p.durationSeconds > 0 ? (shown / p.durationSeconds) * 100 : 0;

  return (
    <div className="flex items-center gap-5 px-6 py-3">
      <button
        onClick={() => (live ? p.onCommand({ op: 'mode', mode: 'review' }) : p.onCommand({ op: playing ? 'pause' : 'play' }))}
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-label text-bg transition active:scale-95"
        aria-label={playing ? 'Pause' : 'Play'}
        title={live ? 'Review this recording' : playing ? 'Pause' : 'Play'}
      >
        {playing ? (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="1" width="3" height="10" rx="1" /><rect x="7" y="1" width="3" height="10" rx="1" /></svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M3 1.6v8.8a.6.6 0 0 0 .9.5l7-4.4a.6.6 0 0 0 0-1L3.9 1.1a.6.6 0 0 0-.9.5z" /></svg>
        )}
      </button>

      <span className="num w-14 shrink-0 text-right text-[13px] text-label">{fmtTime(shown)}</span>

      <input
        type="range"
        min={0}
        max={Math.max(1, Math.floor(p.durationSeconds * p.sampleRateHz))}
        value={Math.floor(shown * p.sampleRateHz)}
        disabled={live}
        onChange={(e) => p.onCommand({ op: 'seek', frame: Number(e.target.value) })}
        style={{ '--pct': `${pct}%` } as React.CSSProperties}
        className="min-w-0 flex-1 outline-none"
        aria-label="Position"
      />

      <span className="num w-14 shrink-0 text-[13px] text-label-2">{fmtTime(p.durationSeconds)}</span>

      <div className="flex shrink-0 items-center gap-2">
        {!live && (
          <Menu
            label="Speed"
            value={String(p.transport?.rateMultiplier ?? 1)}
            options={SPEEDS.map((s) => ({ value: String(s), label: `${s}×` }))}
            onChange={(v) => p.onCommand({ op: 'rate', multiplier: Number(v) })}
          />
        )}
        <Menu
          label="Window"
          value={String(p.windowSeconds)}
          options={WINDOWS.map((s) => ({ value: String(s), label: `${s} s` }))}
          onChange={(v) => p.onWindowSeconds(Number(v))}
        />
      </div>
    </div>
  );
}

function Menu(props: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="relative flex items-center rounded-lg bg-fill px-2.5 py-1 text-[12px]">
      <span className="mr-1.5 text-label-2">{props.label}</span>
      <select
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="num appearance-none bg-transparent pr-3 font-medium text-label outline-none"
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <svg className="pointer-events-none absolute right-2" width="7" height="10" viewBox="0 0 7 10" fill="none" stroke="currentColor" strokeWidth="1.3" opacity="0.5">
        <path d="M1 3.5 3.5 1 6 3.5M1 6.5 3.5 9 6 6.5" />
      </svg>
    </label>
  );
}
