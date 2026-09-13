import { fmtInt } from '../../lib/format';
import type { EmptyMeta } from '../../types';

export function EmptyState({ meta, starting, error, onStart }: { meta: EmptyMeta; starting: boolean; error: string | null; onStart: () => void }) {
  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <div className="flex max-w-sm flex-col items-center text-center">
        <button
          type="button"
          onClick={onStart}
          disabled={starting}
          aria-label="Start recording"
          className="group flex size-20 items-center justify-center rounded-full bg-surface shadow-[0_0_0_0.5px_var(--line),0_4px_16px_rgba(0,0,0,0.06)] transition active:scale-95 disabled:opacity-60"
        >
          <span className="size-8 rounded-full bg-red transition group-hover:scale-105" />
        </button>
        <h1 className="mt-6 text-[22px] font-semibold tracking-tight">{starting ? 'Starting…' : 'Ready to record'}</h1>
        <p className="num mt-1.5 text-[13px] text-label-2">
          {meta.channelCount} channels · {fmtInt(meta.sampleRateHz)} Hz · {fmtInt(meta.channelCount * meta.sampleRateHz)} samples per second
        </p>
        <p className="mt-4 text-[13px] leading-relaxed text-label-2">
          A generator process streams a known signal to a separate recorder, which writes every sample to disk. Stop whenever you like; the
          recording is checked sample by sample as soon as it is saved.
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
