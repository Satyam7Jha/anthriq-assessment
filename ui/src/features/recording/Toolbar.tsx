import { IconButton } from '../../components/ui';
import type { Meta, Session } from '../../types';
import { RecordButton } from './RecordButton';

const STATUS: Partial<Record<Session['state'], string>> = { recording: 'Recording', stopping: 'Saving…', verifying: 'Verifying…' };

export interface ToolbarProps {
  recording: Meta | null;
  state: Session['state'];
  seconds: number;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onStart: () => void;
  onStop: () => void;
}

export function Toolbar({ recording, state, seconds, inspectorOpen, onToggleInspector, onStart, onStop }: ToolbarProps) {
  const status = STATUS[state] ?? (recording?.finalised ? 'Saved' : '');
  return (
    <header className="flex h-13 shrink-0 items-center gap-3 border-b border-line bg-surface/80 px-5 backdrop-blur-xl">
      <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
        <span className="truncate text-[13px] font-semibold">{recording ? recording.file.replace(/\.sigb$/, '') : 'sigacq'}</span>
        {status && <span className="shrink-0 text-[13px] text-label-2">{status}</span>}
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
