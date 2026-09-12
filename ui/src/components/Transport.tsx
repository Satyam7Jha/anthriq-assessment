import type { Meta, TransportState } from '../types';
import { fmtClock, fmtInt } from '../lib';

/**
 * Section 3 of the brief made operable. PLAN §11.8.
 *
 * The brief specifies pause/resume/seek/variable-rate as CLI behaviour. These controls drive the
 * SAME state machine over POST /api/transport, so there is one implementation and the CLI and the
 * UI cannot drift apart.
 *
 * The seek-cost readout is the point of the scrub bar: the server measures the real cost of the seek
 * and returns it, so R36's "cost documented" becomes something a reviewer watches happen rather than
 * a sentence they have to believe.
 */

const RATES = [0.25, 0.5, 1, 2, 4, 8];
const TIME_BASES = [1, 2, 5, 10, 30, 60, 300];

export interface TransportProps {
  meta: Meta;
  transport: TransportState | null;
  mode: 'live' | 'review';
  secondsPerScreen: number;
  onSecondsPerScreen: (s: number) => void;
  onCommand: (cmd: Record<string, unknown>) => void;
  positionFrames: number;
  seekCost: TransportState['seekCost'] | null;
}

export function Transport(p: TransportProps) {
  const total = Math.max(1, p.meta.totalFrames);
  const pos = Math.min(p.positionFrames, total);
  const playing = p.transport?.state === 'PLAYING';
  const rate = p.transport?.rateMultiplier ?? 1;
  const seek = p.seekCost;

  return (
    <div className="flex flex-col gap-2 border-t border-slate-800 bg-slate-900/70 px-4 py-2.5">
      {/* scrub bar */}
      <div className="flex items-center gap-3">
        <span className="num shrink-0 text-xs text-slate-300">{fmtClock(pos / p.meta.sampleRateHz)}</span>
        <input
          type="range"
          min={0}
          max={total}
          step={1}
          value={pos}
          disabled={p.mode === 'live'}
          onChange={(e) => p.onCommand({ op: 'seek', frame: Number(e.target.value) })}
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-slate-700 accent-cyan-400 disabled:cursor-not-allowed disabled:opacity-40"
          title={
            p.mode === 'live'
              ? 'Switch to Review to scrub'
              : p.meta.hadDrops
                ? 'This recording has drops: seek falls back to a binary search over block headers (~12 preads, 768 B for an hour)'
                : 'Drop-free recording: seek is closed-form — one 64-byte pread, O(1)'
          }
        />
        <span className="num shrink-0 text-xs text-slate-500">{fmtClock(p.meta.durationSeconds)}</span>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* mode */}
        <div className="flex overflow-hidden rounded-md border border-slate-700">
          {(['live', 'review'] as const).map((m) => (
            <button
              key={m}
              onClick={() => p.onCommand({ op: 'mode', mode: m })}
              className={`px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide transition ${
                p.mode === m ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-400 hover:bg-slate-800'
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        {/* transport */}
        <div className="flex items-center gap-1">
          <Btn onClick={() => p.onCommand({ op: 'seek', frame: Math.max(0, pos - 10 * p.meta.sampleRateHz) })} title="back 10 s">
            ◀◀
          </Btn>
          <Btn
            onClick={() => p.onCommand({ op: playing ? 'pause' : 'play' })}
            title={playing ? 'pause (position is retained)' : 'play'}
            accent
          >
            {playing ? '❚❚' : '▶'}
          </Btn>
          <Btn onClick={() => p.onCommand({ op: 'seek', frame: Math.min(total, pos + 10 * p.meta.sampleRateHz) })} title="forward 10 s">
            ▶▶
          </Btn>
        </div>

        {/* rate */}
        <div className="flex items-center gap-1">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">rate</span>
          {RATES.map((r) => (
            <button
              key={r}
              onClick={() => p.onCommand({ op: 'rate', multiplier: r })}
              className={`num rounded px-1.5 py-0.5 text-[11px] transition ${
                Math.abs(rate - r) < 1e-6
                  ? 'bg-cyan-500/20 text-cyan-300 ring-1 ring-inset ring-cyan-500/40'
                  : 'text-slate-400 hover:bg-slate-800'
              }`}
            >
              {r}×
            </button>
          ))}
        </div>

        {/* time base — in seconds per screen, the unit a reviewer actually thinks in */}
        <div className="flex items-center gap-1">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">s/screen</span>
          {TIME_BASES.map((s) => (
            <button
              key={s}
              onClick={() => p.onSecondsPerScreen(s)}
              className={`num rounded px-1.5 py-0.5 text-[11px] transition ${
                p.secondsPerScreen === s
                  ? 'bg-cyan-500/20 text-cyan-300 ring-1 ring-inset ring-cyan-500/40'
                  : 'text-slate-400 hover:bg-slate-800'
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        {/* the measured seek cost */}
        <div className="num ml-auto text-[10px] text-slate-500">
          {seek ? (
            <>
              seek <span className="text-slate-300">{seek.microseconds} µs</span> · {seek.probes} pread
              {seek.probes === 1 ? '' : 's'} · {fmtInt(seek.bytesRead)} B ·{' '}
              <span className={seek.method === 'closed-form' ? 'text-emerald-400' : 'text-amber-300'}>{seek.method}</span>
            </>
          ) : (
            <span className="text-slate-600">seek cost shown after a seek</span>
          )}
        </div>
      </div>
    </div>
  );
}

function Btn({
  children,
  onClick,
  title,
  accent,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  accent?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`rounded-md border px-2.5 py-1 text-xs transition ${
        accent
          ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20'
          : 'border-slate-700 text-slate-300 hover:border-slate-600 hover:bg-slate-800'
      }`}
    >
      {children}
    </button>
  );
}
