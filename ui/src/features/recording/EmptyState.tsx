import { fmtDuration, fmtInt } from '../../lib/format';
import type { EmptyMeta } from '../../types';

const STEPS = [
  { title: 'Generate', body: 'A generator process produces a known signal at a fixed real-time rate.' },
  { title: 'Record', body: 'A separate recorder process writes every sample to disk and logs any it has to drop.' },
  { title: 'Verify', body: 'When you stop, a validator checks every saved sample against the signal’s formula.' },
];

export function EmptyState({ meta, starting, error, onStart }: { meta: EmptyMeta; starting: boolean; error: string | null; onStart: () => void }) {
  const limit = meta.limits.maxRecordingSeconds;
  return (
    <main className="flex flex-1 items-center justify-center overflow-y-auto p-8">
      <div className="flex w-full max-w-3xl flex-col items-center text-center">
        <button
          type="button"
          onClick={onStart}
          disabled={starting}
          aria-label="Start recording"
          title="Start recording"
          className="group flex size-24 items-center justify-center rounded-full bg-surface shadow-[0_0_0_0.5px_var(--line),0_4px_16px_rgba(0,0,0,0.06)] transition hover:shadow-[0_0_0_0.5px_var(--line),0_8px_28px_rgba(0,0,0,0.1)] active:scale-95 disabled:opacity-60"
        >
          <span className={`size-10 rounded-full bg-red transition group-hover:scale-105 ${starting ? 'animate-pulse' : ''}`} />
        </button>
        <h1 className="mt-7 text-[28px] font-semibold tracking-tight">{starting ? 'Starting…' : 'Ready to record'}</h1>
        <p className="num mt-2 text-[15px] text-label-2">
          {meta.channelCount} channels · {fmtInt(meta.sampleRateHz)} Hz each · {fmtInt(meta.channelCount * meta.sampleRateHz)} samples per second
        </p>

        <ol className="mt-10 grid w-full gap-4 text-left sm:grid-cols-3">
          {STEPS.map((step, i) => (
            <li key={step.title} className="rounded-2xl bg-surface p-5 shadow-[0_0_0_0.5px_var(--line)]">
              <div className="flex items-center gap-2.5">
                <span className="num flex size-6 items-center justify-center rounded-full bg-fill text-[12px] font-semibold text-label-2">{i + 1}</span>
                <span className="text-[15px] font-semibold">{step.title}</span>
              </div>
              <p className="mt-2.5 text-[13px] leading-relaxed text-label-2">{step.body}</p>
            </li>
          ))}
        </ol>

        <p className="mt-8 text-[13px] text-label-2">
          Press the red button to start.{' '}
          {limit > 0 ? `Recordings on this server stop automatically after ${fmtDuration(limit)}.` : 'Stop whenever you like.'}
        </p>
        {error && (
          <p role="alert" className="mt-4 text-[13px] text-red">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
