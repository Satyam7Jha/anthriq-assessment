import type { ChannelQuality, Meta } from '../types';
import { channelLabel } from '../lib';

/**
 * Per-channel signal-quality indicators. PLAN §11.9.
 *
 * IMPORTANT, and stated in the UI itself rather than buried in a README: these are SYNTHETIC
 * metrics. On real hardware this column is electrode–skin impedance, measured by injecting a small
 * AC current on the ADS1299's lead-off detection pins, and it is the first thing a technician looks
 * at — a high-impedance electrode produces a trace that looks like signal and is not. There is no
 * electrode here, so reporting an impedance number would be a lie. What is shown instead are the
 * honest analogues of what that column is FOR: amplitude, flat-channel detection, and rail
 * detection, plus the one indicator that is a SYSTEM fault rather than a sensor fault — a gap.
 */

export interface QualityStripProps {
  meta: Meta;
  channels: number[];
  quality: Record<string, ChannelQuality>;
  gapChannels: Set<number>;
  useMontage: boolean;
  rowHeight: number;
}

export function QualityStrip(p: QualityStripProps) {
  const maxRms = Math.max(0.05, ...p.channels.map((c) => p.quality[String(c)]?.rms ?? 0));
  return (
    <div className="w-28 shrink-0 select-none border-l border-slate-800">
      <div className="border-b border-slate-800 px-2 py-1 text-[9px] uppercase leading-tight tracking-wider text-slate-500">
        Synthetic quality
        <span className="block normal-case tracking-normal text-slate-600">no impedance measured</span>
      </div>
      {p.channels.map((c) => {
        const q = p.quality[String(c)];
        const hasGap = p.gapChannels.has(c);
        const rmsPct = q ? Math.min(100, (q.rms / maxRms) * 100) : 0;
        return (
          <div
            key={c}
            className="flex items-center gap-1.5 border-b border-slate-900 px-2"
            style={{ height: p.rowHeight }}
            title={
              q
                ? `${channelLabel(c, p.useMontage, p.meta.channelCount)}  RMS ${q.rms.toFixed(4)}  ` +
                  `p-p ${q.peakToPeak.toFixed(4)}  ${q.samplesPerColumn.toFixed(0)} samples/column`
                : 'no data'
            }
          >
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
              <div
                className={`h-full ${q?.flat ? 'bg-slate-600' : q?.railed ? 'bg-amber-400' : 'bg-cyan-400/80'}`}
                style={{ width: `${rmsPct}%` }}
              />
            </div>
            <div className="flex w-9 justify-end gap-0.5">
              {hasGap && <Chip tone="red" label="GAP" title="sample loss in this window — a system fault" />}
              {q?.railed && <Chip tone="amber" label="RAIL" title="clipped at the row boundary" />}
              {q?.flat && <Chip tone="slate" label="FLAT" title="no variation — a disconnected electrode, in hardware terms" />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Chip({ tone, label, title }: { tone: 'red' | 'amber' | 'slate'; label: string; title: string }) {
  const cls =
    tone === 'red'
      ? 'bg-red-500/20 text-red-300'
      : tone === 'amber'
        ? 'bg-amber-400/20 text-amber-300'
        : 'bg-slate-700/40 text-slate-400';
  return (
    <span className={`rounded px-1 text-[8px] font-semibold leading-4 ${cls}`} title={title}>
      {label}
    </span>
  );
}
