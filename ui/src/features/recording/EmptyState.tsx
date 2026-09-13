import { Button } from '../../components/ui';
import { fmtDuration, fmtInt } from '../../lib/format';
import type { EmptyMeta } from '../../types';

const STEPS = [
  { title: 'Generate', body: 'A generator process produces a known signal at a fixed real-time rate.' },
  { title: 'Record', body: 'A separate recorder process writes every sample to disk and logs any it has to drop.' },
  { title: 'Verify', body: 'When you press Stop, a validator checks every saved sample against the signal’s formula.' },
];

export function EmptyState({ meta, starting, error, onStart }: { meta: EmptyMeta; starting: boolean; error: string | null; onStart: () => void }) {
  const limit = meta.limits.maxRecordingSeconds;
  return (
    <main className="flex flex-1 items-center justify-center overflow-y-auto bg-subtle p-8">
      <div className="w-full max-w-3xl overflow-hidden rounded-xl border border-line bg-surface">
        <div className="flex flex-col items-center px-8 pt-10 pb-8 text-center">
          <div className="text-[11px] font-semibold tracking-[0.08em] text-label-2 uppercase">New recording</div>
          <h1 className="mt-2 text-[28px] font-semibold tracking-tight">{starting ? 'Starting…' : 'Ready to record'}</h1>
          <p className="num mt-2 text-[15px] text-label-2">
            {meta.channelCount} channels · {fmtInt(meta.sampleRateHz)} Hz each · {fmtInt(meta.channelCount * meta.sampleRateHz)} samples per second
          </p>
          <Button variant="primary" size="lg" className="mt-6 h-12 px-6 text-[15px]" onClick={onStart} disabled={starting}>
            <span aria-hidden className="size-3 rounded-full bg-white" />
            Start recording
          </Button>
          <p className="mt-3 text-[13px] text-label-2">
            {limit > 0 ? `Press Stop when you have enough. On this server a recording also stops on its own after ${fmtDuration(limit)}.` : 'Press Stop when you have enough.'}
          </p>
          {error && (
            <p role="alert" className="mt-3 text-[13px] text-red">
              {error}
            </p>
          )}
        </div>
        <ol className="grid border-t border-line sm:grid-cols-3">
          {STEPS.map((step, i) => (
            <li key={step.title} className="border-line p-5 text-left not-first:border-t sm:not-first:border-t-0 sm:not-first:border-l">
              <div className="text-[11px] font-semibold tracking-[0.08em] text-label-2 uppercase">Step {i + 1}</div>
              <div className="mt-1 text-[15px] font-semibold">{step.title}</div>
              <p className="mt-1.5 text-[13px] leading-relaxed text-label-2">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </main>
  );
}
