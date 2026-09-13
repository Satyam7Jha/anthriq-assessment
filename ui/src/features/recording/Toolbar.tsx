import { IconButton } from '../../components/ui';
import { fmtTime } from '../../lib/format';
import type { Meta, Session } from '../../types';
import { RecordButton } from './RecordButton';

export interface ToolbarProps {
  recording: Meta | null;
  state: Session['state'];
  seconds: number;
  /** Stops a recording automatically after this long; 0 means never. */
  limitSeconds: number;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onStart: () => void;
  onStop: () => void;
}

/** What is happening right now, in words — never only a colour or an animation. */
function statusText(state: Session['state'], recording: Meta | null, limitSeconds: number): string {
  switch (state) {
    case 'recording':
      return limitSeconds > 0 ? `Recording · stops automatically at ${fmtTime(limitSeconds)}` : 'Recording';
    case 'stopping':
      return 'Saving the file…';
    case 'verifying':
      return 'Checking every sample…';
    default:
      return recording ? (recording.finalised ? 'Saved' : 'Being written') : '';
  }
}

export function Toolbar({ recording, state, seconds, limitSeconds, inspectorOpen, onToggleInspector, onStart, onStop }: ToolbarProps) {
  const status = statusText(state, recording, limitSeconds);
  return (
    <header className="flex h-13 shrink-0 items-center gap-3 border-b border-line bg-surface/80 px-5 backdrop-blur-xl">
      <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
        <span className="truncate text-[13px] font-semibold">{recording ? recording.file.replace(/\.sigb$/, '') : 'sigacq'}</span>
        {status && (
          <span className="shrink-0 text-[13px] text-label-2" aria-live="polite">
            {status}
          </span>
        )}
      </div>
      <RecordButton state={state} seconds={seconds} onStart={onStart} onStop={onStop} />
      {recording && (
        <IconButton label={inspectorOpen ? 'Hide inspector' : 'Show inspector'} active={inspectorOpen} onClick={onToggleInspector}>
          <svg aria-hidden width="16" height="14" viewBox="0 0 16 14" fill="none" stroke="currentColor" strokeWidth="1.4">
            <rect x="0.7" y="0.7" width="14.6" height="12.6" rx="2.5" />
            <path d="M10 1v12" />
          </svg>
        </IconButton>
      )}
    </header>
  );
}
