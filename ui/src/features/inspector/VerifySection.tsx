import { Button, ListGroup, StatusIcon, statusTone, type Status } from '../../components/ui';
import { fmtInt } from '../../lib/format';
import type { Validation } from '../../types';

function verdict(v: Validation): { status: Status; title: string; detail: string } {
  const r = v.report;
  if (!r) return { status: 'fail', title: 'Could not verify', detail: v.stderr.trim().split('\n').pop() || 'The validator could not read this recording.' };
  if (v.exitCode === 0) return { status: 'pass', title: 'Passed', detail: `All ${fmtInt(r.recordedValues)} samples match.` };
  if (v.exitCode === 2) return { status: 'warn', title: 'Passed so far', detail: `${fmtInt(r.recordedValues)} samples match. The recording is still open.` };
  const parts = [r.missing && `${fmtInt(r.missing)} missing`, r.duplicated && `${fmtInt(r.duplicated)} duplicated`, r.incorrect && `${fmtInt(r.incorrect)} incorrect`].filter(Boolean);
  return { status: 'fail', title: 'Failed', detail: parts.join(' · ') || 'The recording contradicts its own drop ledger.' };
}

export function VerifySection({ validation, validating, automatic, onVerify }: { validation: Validation | null; validating: boolean; automatic: boolean; onVerify: () => void }) {
  const v = validation && !validating ? verdict(validation) : null;
  return (
    <ListGroup title="Verify">
      <div className="px-4 py-3.5" aria-live="polite">
        {validating ? (
          <p className="text-[13px] text-label-2">Checking every sample on disk…</p>
        ) : v ? (
          <div className="flex items-start gap-3">
            <StatusIcon status={v.status} />
            <div className="min-w-0">
              <div className={`text-[15px] font-semibold ${statusTone(v.status)}`}>{v.title}</div>
              <div className="num mt-0.5 text-[13px] leading-snug text-label-2">{v.detail}</div>
            </div>
          </div>
        ) : (
          <p className="text-[13px] leading-relaxed text-label-2">
            {automatic ? 'Runs automatically when you stop recording.' : 'Recompute the expected signal and compare every sample on disk.'}
          </p>
        )}
        <Button block className="mt-3" variant={v ? 'secondary' : 'primary'} disabled={validating || automatic} onClick={onVerify}>
          {validating ? 'Verifying…' : v ? 'Verify again' : 'Verify recording'}
        </Button>
      </div>
    </ListGroup>
  );
}
