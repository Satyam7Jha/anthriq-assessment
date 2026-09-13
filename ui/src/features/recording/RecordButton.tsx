import { Button, Spinner } from '../../components/ui';
import { fmtTime } from '../../lib/format';
import type { Session } from '../../types';

/**
 * The one control for the whole recording lifecycle, always in the same place. While recording it
 * reads "Stop and verify" with the elapsed time, because nothing is verified until it is pressed.
 */
export function RecordButton({ state, seconds, onStart, onStop }: { state: Session['state']; seconds: number; onStart: () => void; onStop: () => void }) {
  if (state === 'recording') {
    return (
      <Button variant="primary" size="lg" onClick={onStop} title="Stop and save. The recording is verified straight after." aria-label={`Stop and verify, ${fmtTime(seconds)} recorded`}>
        <span aria-hidden className="size-2.5 rounded-[2px] bg-white" />
        Stop and verify
        <span className="num ml-1 rounded-md bg-white/15 px-1.5 py-0.5 text-[13px]">{fmtTime(seconds)}</span>
      </Button>
    );
  }
  if (state === 'stopping' || state === 'verifying') {
    return (
      <Button size="lg" disabled>
        <Spinner />
        {state === 'stopping' ? 'Saving…' : 'Verifying…'}
      </Button>
    );
  }
  return (
    <Button variant="primary" size="lg" onClick={onStart} title="Start a new recording">
      <span aria-hidden className="size-2.5 rounded-full bg-white" />
      {state === 'done' ? 'New recording' : 'Record'}
    </Button>
  );
}
