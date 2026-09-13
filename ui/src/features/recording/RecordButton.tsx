import { Button } from '../../components/ui';
import { fmtTime } from '../../lib/format';
import type { Session } from '../../types';

/** One control for the whole recording lifecycle, the way a media app does it. */
export function RecordButton({ state, seconds, onStart, onStop }: { state: Session['state']; seconds: number; onStart: () => void; onStop: () => void }) {
  if (state === 'recording') {
    return (
      <Button className="rounded-full text-label" onClick={onStop} title="Stop and save. The recording is verified straight after." aria-label={`Stop recording, ${fmtTime(seconds)} recorded`}>
        <span className="size-2.5 rounded-[3px] bg-red" />
        Stop
        <span className="num text-label-2">{fmtTime(seconds)}</span>
      </Button>
    );
  }
  if (state === 'stopping' || state === 'verifying') {
    return (
      <Button className="rounded-full text-label-2" disabled>
        <span className="size-2 animate-pulse rounded-full bg-label-3" />
        {state === 'stopping' ? 'Saving' : 'Verifying'}
      </Button>
    );
  }
  return (
    <Button className="rounded-full text-label" onClick={onStart} title="Start a new recording">
      <span className="size-2.5 rounded-full bg-red" />
      {state === 'done' ? 'New recording' : 'Record'}
    </Button>
  );
}
