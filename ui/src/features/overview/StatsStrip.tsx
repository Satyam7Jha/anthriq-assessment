import { fmtBytes, fmtDuration, fmtInt, fmtTime } from '../../lib/format';
import type { FrameInfo, Meta, Session, Validation } from '../../types';

/** The five answers a reviewer wants first, each a number with a caption that says what it means. */

type Tone = 'green' | 'orange' | 'red' | 'accent';

interface Stat {
  label: string;
  value: string;
  caption: string;
  tone?: Tone;
}

const TONES: Record<Tone, string> = { green: 'text-green', orange: 'text-orange', red: 'text-red', accent: 'text-accent' };

function verification(state: Session['state'], v: Validation | null): Stat {
  const label = 'Verification';
  if (state === 'recording') return { label, value: 'Pending', caption: 'runs when you press Stop', tone: 'accent' };
  if (state === 'stopping' || state === 'verifying') return { label, value: 'Checking…', caption: 'every sample against the formula', tone: 'accent' };
  if (!v) return { label, value: 'Not run', caption: 'press Verify recording' };
  const r = v.report;
  if (!r) return { label, value: 'Error', caption: 'the validator could not read the file', tone: 'red' };
  if (v.exitCode === 0) return { label, value: 'Passed', caption: `all ${fmtInt(r.recordedValues)} samples match`, tone: 'green' };
  if (v.exitCode === 2) return { label, value: 'Passed so far', caption: 'the recording is still open', tone: 'orange' };
  const found = r.missing + r.duplicated + r.incorrect + r.corrupt;
  return { label, value: 'Failed', caption: `${fmtInt(found)} discrepant samples`, tone: 'red' };
}

export function StatsStrip({ meta, info, state, validation, limitSeconds }: { meta: Meta; info: FrameInfo | null; state: Session['state']; validation: Validation | null; limitSeconds: number }) {
  const rate = meta.sampleRateHz;
  const frames = info?.totalFrames ?? meta.totalFrames;
  const end = (info?.endFrame ?? meta.endFrame) / rate;
  const gaps = meta.markers.length;
  const lost = meta.markers.reduce((sum, m) => sum + m.durationSeconds, 0);
  const health = info?.recorder;

  const stats: Stat[] = [
    {
      label: 'Duration',
      value: fmtTime(end),
      caption: state === 'recording' && limitSeconds > 0 ? `stops on its own at ${fmtTime(limitSeconds)}` : `${meta.channelCount} channels at ${fmtInt(rate)} Hz`,
    },
    { label: 'Samples', value: fmtInt(frames * meta.channelCount), caption: meta.finalised ? 'saved to disk' : 'written to disk so far' },
    gaps
      ? { label: 'Samples lost', value: fmtDuration(lost), caption: `in ${gaps} gap${gaps === 1 ? '' : 's'}, marked on the timeline`, tone: 'red' }
      : { label: 'Samples lost', value: '0', caption: 'no gaps in the recording' },
    verification(state, validation),
    health
      ? { label: 'Buffer used', value: `${health.ringFillPct.toFixed(1)}%`, caption: `recorder memory ${fmtBytes(health.rssBytes)}, flat` }
      : { label: 'Buffer used', value: '—', caption: 'no live recorder for this file' },
  ];

  return (
    <div className="grid shrink-0 grid-cols-2 border-b border-line md:grid-cols-5">
      {stats.map((s) => (
        <div key={s.label} className="min-w-0 border-line px-6 py-4 not-first:border-l">
          <div className="text-[11px] font-semibold tracking-[0.08em] text-label-2 uppercase">{s.label}</div>
          <div className={`num mt-1.5 truncate text-[26px] leading-tight font-semibold tracking-tight ${s.tone ? TONES[s.tone] : 'text-label'}`}>{s.value}</div>
          <div className="num mt-0.5 truncate text-[13px] text-label-2">{s.caption}</div>
        </div>
      ))}
    </div>
  );
}
