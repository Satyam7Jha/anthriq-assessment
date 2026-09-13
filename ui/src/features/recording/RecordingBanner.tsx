import { Spinner } from '../../components/ui';
import type { Session } from '../../types';

/** Narrates the seconds between pressing Stop and seeing the verdict, so the wait is never unexplained. */
export function RecordingBanner({ state }: { state: Session['state'] }) {
  if (state !== 'stopping' && state !== 'verifying') return null;
  return (
    <div role="status" className="flex shrink-0 items-center gap-3 border-b border-line bg-accent-soft px-5 py-3 text-[13px]">
      <Spinner className="text-accent" />
      <span className="font-semibold text-accent">{state === 'stopping' ? 'Saving the file' : 'Verifying'}</span>
      <span className="text-label-2">
        {state === 'stopping' ? 'Writing the last blocks and the header, so the recording is complete on disk…' : 'A separate validator is checking every sample against the signal’s formula…'}
      </span>
    </div>
  );
}
