import type { Meta } from '../types';
import { channelLabel, fmtBytes } from '../lib';

/**
 * Channel selection that actually reaches the disk. PLAN §11.7.
 *
 * This picker does NOT filter an already-loaded full set in the browser. Selecting channels changes
 * the `channels=` parameter, which changes the set of preads the reader issues, which changes the
 * number of bytes that leave the disk. The readout below makes that visible: measured bytes, the
 * all-channel equivalent, and the ratio — so clicking two checkboxes demonstrates the storage-layout
 * decision paying off, with the arithmetic checked in front of the reviewer.
 */

export interface MontagePickerProps {
  meta: Meta;
  selected: number[];
  onChange: (channels: number[]) => void;
  useMontage: boolean;
  onToggleMontage: (v: boolean) => void;
  measuredBytes: number;
  allChannelBytes: number;
  predictedBytes: number;
}

const PRESETS: { name: string; pick: (c: number) => number[] }[] = [
  { name: 'All', pick: (c) => Array.from({ length: c }, (_, i) => i) },
  { name: 'First 8', pick: (c) => Array.from({ length: Math.min(8, c) }, (_, i) => i) },
  { name: 'Frontal', pick: (c) => [0, 1, 2, 3, 4, 5, 6].filter((i) => i < c) },
  { name: 'Every 4th', pick: (c) => Array.from({ length: c }, (_, i) => i).filter((i) => i % 4 === 0) },
];

export function MontagePicker(p: MontagePickerProps) {
  const { channelCount } = p.meta;
  const selectedSet = new Set(p.selected);
  const ratio = (p.selected.length / channelCount) * 100;
  const saving = p.measuredBytes > 0 ? p.allChannelBytes / p.measuredBytes : 0;

  const toggle = (c: number) => {
    const next = selectedSet.has(c) ? p.selected.filter((x) => x !== c) : [...p.selected, c].sort((a, b) => a - b);
    if (next.length > 0) p.onChange(next);
  };

  return (
    <div className="text-sm">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">Montage</h3>
        <label className="flex cursor-pointer items-center gap-1.5 text-[10px] text-slate-400">
          <input
            type="checkbox"
            checked={p.useMontage}
            onChange={(e) => p.onToggleMontage(e.target.checked)}
            className="size-3 accent-cyan-500"
          />
          10–20 labels
        </label>
      </div>

      <div className="mb-2 flex flex-wrap gap-1">
        {PRESETS.map((preset) => (
          <button
            key={preset.name}
            onClick={() => p.onChange(preset.pick(channelCount))}
            className="rounded border border-slate-700 px-2 py-0.5 text-[10px] text-slate-300 transition hover:border-cyan-500/60 hover:text-cyan-300"
          >
            {preset.name}
          </button>
        ))}
      </div>

      <div className="grid max-h-48 grid-cols-4 gap-0.5 overflow-y-auto pr-1">
        {Array.from({ length: channelCount }, (_, c) => {
          const on = selectedSet.has(c);
          return (
            <button
              key={c}
              onClick={() => toggle(c)}
              className={`num rounded px-1 py-1 text-[10px] transition ${
                on
                  ? 'bg-cyan-500/15 text-cyan-300 ring-1 ring-inset ring-cyan-500/40'
                  : 'text-slate-500 hover:bg-slate-800 hover:text-slate-300'
              }`}
              title={`channel ${c}`}
            >
              {channelLabel(c, p.useMontage, channelCount)}
            </button>
          );
        })}
      </div>

      {/* The readout that turns a UI control into evidence for a storage decision. */}
      <dl className="mt-3 space-y-1 rounded-md border border-slate-800 bg-slate-900/60 p-2 text-[10px]">
        <div className="flex justify-between">
          <dt className="text-slate-500">selected</dt>
          <dd className="num text-slate-200">
            {p.selected.length} of {channelCount}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-slate-500">bytes read</dt>
          <dd className="num text-slate-200">{fmtBytes(p.measuredBytes)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-slate-500">predicted (§9.2)</dt>
          <dd className="num text-slate-400">
            {fmtBytes(p.predictedBytes)}{' '}
            {/* Measured versus the closed form. The tick is the check that the storage-layout claim
                is arithmetic rather than assertion — it disappears the moment they disagree. */}
            <span className={p.measuredBytes === p.predictedBytes ? 'text-emerald-400' : 'text-red-400'}>
              {p.measuredBytes === p.predictedBytes ? '✓' : '✗'}
            </span>
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-slate-500">all-channel equiv.</dt>
          <dd className="num text-slate-400">{fmtBytes(p.allChannelBytes)}</dd>
        </div>
        <div className="flex justify-between border-t border-slate-800 pt-1">
          <dt className="text-slate-500">saving</dt>
          <dd className="num font-medium text-cyan-300">{saving > 0 ? `${saving.toFixed(2)}×` : '—'}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-slate-500">k/C</dt>
          <dd className="num text-slate-400">{ratio.toFixed(2)}%</dd>
        </div>
      </dl>
      <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
        Selection changes which preads the reader issues, not which series the browser draws. Planar
        blocks make a k-of-{channelCount} subset cost k/{channelCount} of the payload.
      </p>
    </div>
  );
}
