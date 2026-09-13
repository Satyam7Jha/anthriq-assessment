import { useState } from 'react';
import type { FrameInfo, Meta, SeekCost, Validation } from '../types';
import { fmtBytes, fmtInt, fmtTime } from '../lib';

/**
 * The inspector answers a reviewer's questions in the order they ask them:
 *   1. Is the recording correct?      Verify
 *   2. What is it?                     Recording
 *   3. Is acquisition healthy?         Health
 *   4. How much am I looking at?       Channels
 * Everything technical sits behind one disclosure at the bottom.
 */

export interface InspectorProps {
  meta: Meta;
  info: FrameInfo | null;
  channelCount: number;
  onChannelCount: (n: number) => void;
  validation: Validation | null;
  validating: boolean;
  onValidate: () => void;
  frameMs: number;
  seekCost: SeekCost | null;
}

export function Inspector(p: InspectorProps) {
  const [details, setDetails] = useState(false);
  const C = p.meta.channelCount;
  const counts = [C, 16, 8, 4].filter((n, i, a) => n <= C && a.indexOf(n) === i);
  const totalFrames = p.info?.totalFrames ?? p.meta.totalFrames;
  const saving = p.info && p.info.bytesRead > 0 ? p.info.allChannelBytes / p.info.bytesRead : 1;
  const h = p.info?.recorder ?? null;

  return (
    <div className="flex flex-col gap-6 px-5 py-6">
      <Group title="Verify">
        <div className="px-4 py-3.5">
          {p.validation ? (
            <Verdict v={p.validation} />
          ) : (
            <p className="text-[13px] leading-relaxed text-label-2">
              Recompute the expected signal and compare every sample on disk.
            </p>
          )}
          <button
            onClick={p.onValidate}
            disabled={p.validating}
            className={`mt-3 w-full rounded-lg py-2 text-[13px] font-medium transition active:scale-[0.99] disabled:opacity-50 ${
              p.validation ? 'bg-fill text-accent' : 'bg-accent text-white'
            }`}
          >
            {p.validating ? 'Verifying…' : p.validation ? 'Verify again' : 'Verify recording'}
          </button>
        </div>
      </Group>

      <Group title="Recording">
        <Row label="Channels" value={`${C}`} />
        <Row label="Sample rate" value={`${fmtInt(p.meta.sampleRateHz)} Hz`} />
        <Row label="Duration" value={fmtTime(totalFrames / p.meta.sampleRateHz)} />
        <Row label="Samples" value={fmtInt(totalFrames * C)} last />
      </Group>

      <Group title="Health">
        {h ? (
          <>
            <Row label="Lost samples" value={fmtInt(h.droppedFrames * C)} tone={h.droppedFrames ? 'red' : undefined} />
            <Row label="Buffer used" value={`${h.ringFillPct.toFixed(1)}%`} />
            <Row label="Slowest write" value={`${h.writeLatencyMaxMs.toFixed(1)} ms`} />
            <Row label="Recorder memory" value={fmtBytes(h.rssBytes)} last />
          </>
        ) : (
          <Row
            label="Lost samples"
            value={fmtInt(p.meta.droppedValues)}
            tone={p.meta.droppedValues ? 'red' : undefined}
            last
          />
        )}
      </Group>

      <Group
        title="Channels shown"
        footer={p.info && saving > 1.05 ? `Only these channels are read from disk — ${saving.toFixed(1)}× less data.` : null}
      >
        <div className="p-2">
          <Segmented
            options={counts.map((n) => (n === C ? 'All' : String(n)))}
            value={p.info ? (p.info.channels.length === C ? 'All' : String(p.info.channels.length)) : 'All'}
            onChange={(v) => p.onChannelCount(v === 'All' ? C : Number(v))}
          />
        </div>
      </Group>

      <div>
        <button
          onClick={() => setDetails(!details)}
          className="flex w-full items-center gap-1.5 px-4 text-[12px] text-label-2 outline-none"
        >
          <svg width="8" height="8" viewBox="0 0 8 8" className={`transition-transform ${details ? 'rotate-90' : ''}`} fill="currentColor">
            <path d="M2 1l4 3-4 3z" />
          </svg>
          Details
        </button>
        {details && (
          <div className="mt-2 overflow-hidden rounded-xl bg-surface">
            <Row label="File" value={p.meta.file} />
            <Row label="Size" value={fmtBytes(p.meta.fileSizeBytes)} />
            <Row label="Format" value={`${p.meta.dtype}, planar blocks`} />
            <Row label="Read per frame" value={p.info ? fmtBytes(p.info.bytesRead) : '—'} />
            <Row label="Last seek" value={p.seekCost ? `${p.seekCost.microseconds} µs` : '—'} />
            <Row label="Draw time" value={`${p.frameMs.toFixed(2)} ms`} last />
          </div>
        )}
      </div>

      <p className="px-4 text-[11px] leading-relaxed text-label-3">
        Space play · ← → skip 10 s
      </p>
    </div>
  );
}

function Verdict({ v }: { v: Validation }) {
  const r = v.report;
  if (!r) return <p className="text-[13px] text-red">Could not read this recording.</p>;
  const pass = v.exitCode === 0;
  const open = v.exitCode === 2;
  const tone = pass ? 'text-green' : open ? 'text-orange' : 'text-red';
  const title = pass ? 'Passed' : open ? 'Passed so far' : 'Failed';
  const detail = pass
    ? `All ${fmtInt(r.recordedValues)} samples match.`
    : open
      ? `${fmtInt(r.recordedValues)} samples match. Recording is still open.`
      : [r.missing && `${fmtInt(r.missing)} missing`, r.duplicated && `${fmtInt(r.duplicated)} duplicated`, r.incorrect && `${fmtInt(r.incorrect)} incorrect`]
          .filter(Boolean)
          .join(' · ') || 'The recording contradicts its own drop ledger.';
  return (
    <div className="flex items-start gap-3">
      <span className={`mt-0.5 ${tone}`}>
        <svg width="22" height="22" viewBox="0 0 22 22" fill="currentColor">
          <circle cx="11" cy="11" r="11" />
          {pass || open ? (
            <path d="M6.5 11.3l3 3 6-6.3" stroke="white" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          ) : (
            <path d="M7.5 7.5l7 7M14.5 7.5l-7 7" stroke="white" strokeWidth="2" strokeLinecap="round" />
          )}
        </svg>
      </span>
      <div className="min-w-0">
        <div className={`text-[15px] font-semibold ${tone}`}>{title}</div>
        <div className="num mt-0.5 text-[13px] leading-snug text-label-2">{detail}</div>
      </div>
    </div>
  );
}

function Group({ title, footer, children }: { title: string; footer?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 px-4 text-[12px] font-medium text-label-2">{title}</h3>
      <div className="overflow-hidden rounded-xl bg-surface">{children}</div>
      {footer && <p className="mt-1.5 px-4 text-[11px] leading-snug text-label-2">{footer}</p>}
    </section>
  );
}

function Row({ label, value, tone, last }: { label: string; value: string; tone?: 'red'; last?: boolean }) {
  return (
    <>
      <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-[13px]">
        <span className="text-label">{label}</span>
        <span className={`num truncate text-right ${tone === 'red' ? 'text-red' : 'text-label-2'}`}>{value}</span>
      </div>
      {!last && <div className="ml-4 h-px bg-line" />}
    </>
  );
}

export function Segmented({ options, value, onChange }: { options: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex rounded-lg bg-fill p-0.5">
      {options.map((o) => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className={`flex-1 rounded-[7px] py-1 text-[12px] font-medium outline-none transition ${
            o === value ? 'bg-surface text-label shadow-[0_1px_3px_rgba(0,0,0,0.12)]' : 'text-label-2'
          }`}
        >
          {o}
        </button>
      ))}
    </div>
  );
}
