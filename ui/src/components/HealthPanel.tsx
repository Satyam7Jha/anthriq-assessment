import type { RecorderHealth, Meta } from '../types';
import { fmtBytes, fmtInt } from '../lib';

/**
 * Where backend rigour becomes visible in two seconds. PLAN §11.10.
 *
 * Every number here already exists for another reason — the recorder appends its periodic stats as
 * NDJSON and the UI server tails that file the same read-only way it tails the .sigb. No socket, no
 * IPC: telemetry does not get to become a backpressure path either.
 */

function Bar({ pct, level }: { pct: number; level: string }) {
  const tone =
    level === 'HIGH' ? 'bg-red-500' : level === 'ELEVATED' ? 'bg-amber-400' : 'bg-cyan-400';
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
      <div className={`h-full ${tone} transition-[width] duration-200`} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="shrink-0 text-[11px] uppercase tracking-wider text-slate-500">{label}</span>
      <span className="num text-right text-xs text-slate-200">{children}</span>
    </div>
  );
}

export interface HealthPanelProps {
  health: RecorderHealth | null | undefined;
  meta: Meta;
  fps: number;
  frameMs: number;
  pushBytes: number;
  allChannelBytes: number;
  onValidate: () => void;
  validating: boolean;
  validation: { exitCode: number; report: Record<string, unknown> | null; stderr: string } | null;
}

export function HealthPanel(p: HealthPanelProps) {
  const h = p.health;
  const ring = h?.ringFillPct ?? 0;
  const saving = p.pushBytes > 0 ? p.allChannelBytes / p.pushBytes : 0;

  return (
    <div className="flex flex-col gap-4 text-sm">
      <section>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-400">
          Acquisition health
        </h3>
        {h ? (
          <div className="space-y-2">
            <div>
              <div className="mb-1 flex justify-between text-[11px] text-slate-400">
                <span>ring fill</span>
                <span className="num">
                  {h.ringFillPct.toFixed(1)}% · {h.ringHeadroomSeconds.toFixed(0)}s headroom of{' '}
                  {meta_ringSeconds(p.meta)}s
                </span>
              </div>
              <Bar pct={ring} level={h.ringLevel} />
            </div>
            <Row label="watermark">
              <span
                className={
                  h.ringLevel === 'HIGH' ? 'text-red-400' : h.ringLevel === 'ELEVATED' ? 'text-amber-300' : 'text-emerald-400'
                }
              >
                {h.ringLevel}
              </span>{' '}
              <span className="text-slate-500">peak {h.ringPeakPct.toFixed(2)}%</span>
            </Row>
            <Row label="received">{fmtInt(h.valuesReceived)} values</Row>
            <Row label="written">
              {fmtInt(h.blocksWritten)} blocks · {fmtBytes(h.bytesWritten)}
            </Row>
            <Row label="write latency">max {h.writeLatencyMaxMs.toFixed(2)} ms</Row>
            <Row label="fsync">
              {h.fsyncCount}× · max {h.fsyncMaxMs.toFixed(1)} ms
            </Row>
            <Row label="dropped">
              <span className={h.droppedFrames > 0 ? 'text-red-400' : 'text-emerald-400'}>
                {fmtInt(h.droppedFrames * p.meta.channelCount)} values in {h.droppedRanges} range
                {h.droppedRanges === 1 ? '' : 's'}
              </span>
            </Row>
            <Row label="integrity">
              <span className={h.crcFailures > 0 ? 'text-red-400' : 'text-slate-400'}>
                {h.crcFailures} CRC fail · {fmtInt(h.gapFrames)} gap frames · {fmtInt(h.duplicateFrames)} dup
              </span>
            </Row>
            <Row label="recorder RSS">{fmtBytes(h.rssBytes)}</Row>
          </div>
        ) : (
          <p className="text-xs leading-relaxed text-slate-500">
            No live recorder telemetry. Start the recorder with{' '}
            <code className="rounded bg-slate-800 px-1 text-[11px] text-slate-300">--stats-out</code> pointing at{' '}
            <code className="rounded bg-slate-800 px-1 text-[11px] text-slate-300">
              {p.meta.file.replace(/\.sigb$/, '')}.stats.ndjson
            </code>{' '}
            to populate this panel. Viewing a completed recording works without it.
          </p>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-400">Render budget</h3>
        {/* Two DIFFERENT numbers, kept apart on purpose.
            `frame time` is the cost of OUR draw: environment-independent, and the one that says
            whether the renderer can keep up. `rAF rate` is how often the host actually schedules a
            frame, which an embedded or backgrounded view throttles to a few Hz regardless of how
            fast the draw is. Reporting only the second would make a throttled preview look like a
            performance failure; reporting only the first would hide a genuinely dropped frame. */}
        <Row label="frame time">
          <span className={p.frameMs <= 8 ? 'text-emerald-400' : p.frameMs <= 16 ? 'text-amber-300' : 'text-red-400'}>
            {p.frameMs.toFixed(2)} ms
          </span>
          <span className="text-slate-500"> / 16.7 ms budget</span>
        </Row>
        <Row label="draw headroom">
          <span className="text-cyan-300">
            {p.frameMs > 0 ? `${Math.round(1000 / p.frameMs).toLocaleString('en-US')} fps` : '—'}
          </span>
          <span className="text-slate-500"> at this draw cost</span>
        </Row>
        <Row label="rAF rate">
          <span className={p.fps >= 55 ? 'text-emerald-400' : 'text-slate-400'}>{p.fps.toFixed(0)} /s</span>
          <span className="text-slate-500">{p.fps < 55 ? ' host-throttled' : ''}</span>
        </Row>
        <Row label="bytes read / push">{fmtBytes(p.pushBytes)}</Row>
        <Row label="all-channel equiv.">{fmtBytes(p.allChannelBytes)}</Row>
        <Row label="subset saving">
          <span className="text-cyan-300">{saving > 0 ? `${saving.toFixed(2)}× fewer bytes read` : '—'}</span>
        </Row>
      </section>

      <section>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-400">Verification</h3>
        <button
          onClick={p.onValidate}
          disabled={p.validating}
          className="w-full rounded-md border border-slate-700 bg-slate-800/60 px-3 py-2 text-xs font-medium text-slate-200 transition hover:border-cyan-500/60 hover:bg-slate-800 disabled:opacity-50"
          title={
            p.meta.finalised
              ? 'Runs bin/sigval.js as a separate process and reports its exit code verbatim'
              : 'This file is still being written: the validator will check the committed prefix and exit 2'
          }
        >
          {p.validating ? 'validating…' : 'Run validator'}
        </button>
        {p.validation && <ValidationResult v={p.validation} />}
        <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
          Spawned as a separate process. The validator's independence is what makes its verdict worth
          anything, so the UI cannot influence it.
        </p>
      </section>
    </div>
  );
}

function ValidationResult({ v }: { v: NonNullable<HealthPanelProps['validation']> }) {
  const r = (v.report ?? {}) as Record<string, number | string>;
  const verdict = String(r.result ?? (v.exitCode === 0 ? 'PASS' : 'UNREADABLE'));
  const good = v.exitCode === 0;
  const partial = v.exitCode === 2;
  return (
    <div className="mt-2 rounded-md border border-slate-700 bg-slate-900/80 p-2">
      <div className="mb-1 flex items-center justify-between">
        <span
          className={`text-xs font-semibold ${good ? 'text-emerald-400' : partial ? 'text-amber-300' : 'text-red-400'}`}
        >
          {verdict}
        </span>
        <span className="num text-[10px] text-slate-500">exit {v.exitCode}</span>
      </div>
      {v.report ? (
        <pre className="num overflow-x-auto text-[10px] leading-relaxed text-slate-300">
          {`Expected: ${fmtInt(Number(r.expectedValues))} samples
Recorded: ${fmtInt(Number(r.recordedValues))} samples
Missing:   ${fmtInt(Number(r.missing))}
Duplicated: ${fmtInt(Number(r.duplicated))}
Incorrect:  ${fmtInt(Number(r.incorrect))}
Result: ${verdict}`}
        </pre>
      ) : (
        <pre className="overflow-x-auto text-[10px] text-red-300">{v.stderr.slice(-400)}</pre>
      )}
    </div>
  );
}

function meta_ringSeconds(m: Meta): string {
  return m.ringSeconds.toFixed(0);
}
