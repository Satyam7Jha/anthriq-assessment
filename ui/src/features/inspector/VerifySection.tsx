import { useEffect, useState } from 'react';
import { Button, StatusIcon, statusTone, type Status } from '../../components/ui';
import { fmtInt, fmtPosition } from '../../lib/format';
import type { Discrepancy, Validation, ValidationReport } from '../../types';

/**
 * The verdict, and the evidence it rests on. Verification is a separate validator process; this panel
 * restates its report as the five checks it performs. The checks sit in a collapsed disclosure whose
 * summary still shows every check's status, so the panel stays short without hiding a failure. While a
 * recording runs, the action here is Stop: nothing can be verified until the file is saved.
 */

interface Check {
  label: string;
  status: Status;
  detail: string;
}

/** What each check means, shown before the first run so nobody has to guess what "Verify" does. */
const PLANNED: Check[] = [
  { label: 'Sample values', status: 'pending', detail: 'Each sample is recomputed from the signal’s formula and compared bit for bit.' },
  { label: 'Sequence', status: 'pending', detail: 'No sample is missing or repeated.' },
  { label: 'Checksums', status: 'pending', detail: 'Every block still matches the CRC-32C written with it.' },
  { label: 'Drop log', status: 'pending', detail: 'The recorder’s own log of dropped samples agrees with the gaps found.' },
  { label: 'File', status: 'pending', detail: 'The recording was saved and closed cleanly.' },
];

const where = (d: Discrepancy | null): string => {
  if (!d || d.timeSeconds === undefined) return '';
  return ` First at ${fmtPosition(d.timeSeconds)}${d.channel === undefined ? '' : `, channel ${d.channel + 1}`}.`;
};

function checksFor(r: ValidationReport): Check[] {
  const first = r.firstDiscrepancy;
  const blocks = `${fmtInt(r.blockCount)} block${r.blockCount === 1 ? '' : 's'}`;
  const lost = r.missing > 0 || r.duplicated > 0;
  return [
    {
      label: 'Sample values',
      status: r.incorrect ? 'fail' : 'pass',
      detail: r.incorrect
        ? `${fmtInt(r.incorrect)} differ from the formula.${where(first.incorrect)}${first.incorrect?.expected === undefined ? '' : ` Expected ${first.incorrect.expected}, found ${first.incorrect.actual}.`}`
        : `${fmtInt(r.recordedValues - r.corrupt)} recomputed from the formula, identical bit for bit.`,
    },
    {
      label: 'Sequence',
      status: lost ? 'fail' : 'pass',
      detail: lost
        ? [r.missing ? `${fmtInt(r.missing)} missing.${where(first.missing)}` : '', r.duplicated ? `${fmtInt(r.duplicated)} repeated.${where(first.duplicated)}` : ''].filter(Boolean).join(' ')
        : `No gaps or repeats across ${fmtInt(r.expectedValues)} expected samples.`,
    },
    {
      label: 'Checksums',
      status: !r.crcChecked ? 'pending' : r.corrupt ? 'fail' : 'pass',
      detail: !r.crcChecked
        ? 'Skipped for this run.'
        : r.corrupt
          ? `${fmtInt(r.corrupt)} samples sit in damaged blocks${first.corrupt?.blockIndex === undefined ? '' : `, the first in block ${fmtInt(first.corrupt.blockIndex + 1)}`}.`
          : `All ${blocks} match their CRC-32C.`,
    },
    {
      label: 'Drop log',
      status: r.ledgerAgreesWithDerivedGaps === null ? 'pending' : r.ledgerAgreesWithDerivedGaps ? 'pass' : 'fail',
      detail:
        r.ledgerAgreesWithDerivedGaps === null
          ? 'Compared once the recording is saved.'
          : r.ledgerAgreesWithDerivedGaps
            ? r.declaredDroppedValues
              ? `The recorder logged ${fmtInt(r.declaredDroppedValues)} dropped samples, exactly the gaps found.`
              : 'The recorder logged no drops, and none were found.'
            : `The recorder logged ${fmtInt(r.declaredDroppedValues ?? 0)} dropped samples, but ${fmtInt(r.missing)} are missing.`,
    },
    {
      label: 'File',
      status: r.truncated ? 'warn' : 'pass',
      detail: r.truncated
        ? r.finalised
          ? 'Saved, but shorter than its header says.'
          : `Still being written, so checked up to the last complete block (${blocks}).`
        : 'Saved and closed cleanly.',
    },
  ];
}

function headline(v: Validation, checks: Check[]): { status: Status; title: string; summary: string } {
  if (!v.report) return { status: 'fail', title: 'Could not verify', summary: v.stderr.trim().split('\n').pop() || 'The validator could not read this recording.' };
  if (v.exitCode === 0) return { status: 'pass', title: 'Passed', summary: 'Every sample on disk is exactly what the generator produced.' };
  if (v.exitCode === 2) return { status: 'warn', title: 'Passed so far', summary: 'Everything written so far is correct. The recording is still open.' };
  const failed = checks.filter((c) => c.status === 'fail').length;
  return { status: 'fail', title: 'Failed', summary: `${failed} of ${checks.length} checks found a problem. Open the checks to see where each one starts.` };
}

/** The disclosure's one-line summary: how many checks passed, in words, or what the list is. */
function checksSummary(checks: Check[], ran: boolean, validating: boolean): { text: string; tone: string } {
  if (validating) return { text: `Running ${checks.length} checks…`, tone: 'text-label-2' };
  if (!ran) return { text: `What gets checked (${checks.length})`, tone: 'text-label' };
  const passed = checks.filter((c) => c.status === 'pass').length;
  const failed = checks.some((c) => c.status === 'fail');
  return { text: `${passed} of ${checks.length} checks passed`, tone: failed ? 'text-red' : 'text-label' };
}

function CheckRow({ check }: { check: Check }) {
  return (
    <li className="flex gap-3 px-4 py-2.5">
      <span className="mt-px">
        <StatusIcon status={check.status} size={16} />
      </span>
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-label">{check.label}</div>
        <div className="num mt-0.5 text-[12px] leading-snug text-label-2">{check.detail}</div>
      </div>
    </li>
  );
}

export interface VerifySectionProps {
  validation: Validation | null;
  validating: boolean;
  /** A recording is running: it can only be verified once Stop has saved it. */
  recordingInProgress: boolean;
  onVerify: () => void;
}

export function VerifySection({ validation, validating, recordingInProgress, onVerify }: VerifySectionProps) {
  const report = validation?.report ?? null;
  const shown = !validating && !recordingInProgress && validation;
  const checks = shown && report ? checksFor(report) : PLANNED;
  const head = shown ? headline(validation, checks) : null;
  const summary = checksSummary(checks, !!(shown && report), validating);

  // Whenever a finished result is on screen its checks are open, so the detail behind "Passed" is in
  // view. Before there is a result — recording, checking, not yet verified — the list stays closed. The
  // person can still close it; a new result opens it again.
  const resultReady = !!(shown && report);
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(resultReady), [resultReady, validation]);

  const title = head ? head.title : validating ? 'Checking every sample…' : recordingInProgress ? 'Waiting for Stop' : 'Not verified yet';
  const text = head
    ? head.summary
    : recordingInProgress
      ? 'A recording can only be verified once it is saved. Press Stop and verify at the top of the page, and verification runs straight away.'
      : 'A separate validator program rebuilds the expected signal from its formula and checks the saved file against it.';

  return (
    <section aria-label="Verify" className="border-b border-line py-4">
      <h2 className="mb-3 px-5 text-[14px] font-semibold text-label">Verify</h2>
      <div className="flex items-start gap-3 px-5" aria-live="polite" aria-busy={validating}>
        {head && <StatusIcon status={head.status} />}
        <div className="min-w-0">
          <div className={`text-[16px] font-semibold ${head ? statusTone(head.status) : 'text-label'}`}>{title}</div>
          <p className="mt-0.5 text-[13px] leading-snug text-label-2">{text}</p>
        </div>
      </div>

      {(!validation || report || validating || recordingInProgress) && (
        <details className="group mx-5 mt-3 overflow-hidden rounded-lg border border-line" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
          <summary className="flex min-h-10 cursor-pointer list-none items-center gap-3 px-4 py-2 transition hover:bg-subtle focus-visible:rounded-none focus-visible:outline-offset-[-2px] [&::-webkit-details-marker]:hidden">
            <span className={`min-w-0 flex-1 text-[13px] font-medium ${summary.tone}`}>{summary.text}</span>
            <span aria-hidden className={`flex gap-1 transition-opacity ${validating ? 'opacity-50' : ''}`}>
              {checks.map((c) => (
                <StatusIcon key={c.label} status={c.status} size={12} />
              ))}
            </span>
            <svg aria-hidden width="8" height="8" viewBox="0 0 8 8" className="shrink-0 text-label-3 transition-transform group-open:rotate-90" fill="currentColor">
              <path d="M2 1l4 3-4 3z" />
            </svg>
          </summary>
          <ul className={`border-t border-line py-1 transition-opacity ${validating ? 'opacity-50' : ''}`}>
            {checks.map((c) => (
              <CheckRow key={c.label} check={c} />
            ))}
          </ul>
        </details>
      )}

      {/* While recording, the only action is Stop, and it lives in the top bar. */}
      {!recordingInProgress && (
        <div className="mt-3 px-5">
          <Button block size="lg" variant={shown ? 'secondary' : 'primary'} disabled={validating} onClick={onVerify}>
            {validating ? 'Verifying…' : shown ? 'Verify again' : 'Verify recording'}
          </Button>
        </div>
      )}

      {shown && report && (
        <p className="num mt-2.5 px-5 text-[12px] leading-snug text-label-2">
          Checked {fmtInt(report.recordedValues)} samples in {report.elapsedSeconds < 0.1 ? 'under 0.1' : report.elapsedSeconds.toFixed(1)} s by a separate process, exit
          code {validation.exitCode}. From a terminal: <code className="font-mono text-[11px] text-label">node bin/sigval.ts FILE</code>
        </p>
      )}
    </section>
  );
}
