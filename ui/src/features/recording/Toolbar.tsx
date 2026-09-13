import { IconButton } from '../../components/ui';
import type { Meta, Session } from '../../types';
import { RecordButton } from './RecordButton';

export interface ToolbarProps {
  recording: Meta | null;
  state: Session['state'];
  seconds: number;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onStart: () => void;
  onStop: () => void;
}

/** What is happening right now, as a word in a coloured pill — never only a colour or an animation. */
function statusPill(state: Session['state'], recording: Meta | null): { text: string; className: string; live?: boolean } | null {
  switch (state) {
    case 'recording':
      return { text: 'Recording', className: 'bg-red-soft text-red', live: true };
    case 'stopping':
      return { text: 'Saving', className: 'bg-accent-soft text-accent' };
    case 'verifying':
      return { text: 'Verifying', className: 'bg-accent-soft text-accent' };
    default:
      if (!recording) return null;
      return recording.finalised ? { text: 'Saved', className: 'bg-green-soft text-green' } : { text: 'Being written', className: 'bg-subtle text-label-2' };
  }
}

export function Toolbar({ recording, state, seconds, inspectorOpen, onToggleInspector, onStart, onStop }: ToolbarProps) {
  const pill = statusPill(state, recording);
  return (
    <header className="flex h-16 shrink-0 items-center gap-4 border-b border-line bg-surface px-6">
      <div className="flex shrink-0 items-center gap-2.5">
        <span aria-hidden className="flex size-8 items-center justify-center rounded-lg bg-accent text-white">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1.5 9h2.5l2-5 3 10 2.5-7 1.5 2h3.5" />
          </svg>
        </span>
        <span className="text-[17px] font-semibold tracking-tight">sigacq</span>
      </div>
      <span aria-hidden className="h-6 w-px bg-line" />
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="truncate text-[15px] font-semibold">{recording ? recording.file.replace(/\.sigb$/, '') : 'No recording yet'}</span>
        {pill && (
          <span aria-live="polite" className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-medium ${pill.className}`}>
            {pill.live && <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-current" />}
            {pill.text}
          </span>
        )}
      </div>
      <RecordButton state={state} seconds={seconds} onStart={onStart} onStop={onStop} />
      {recording && (
        <IconButton label={inspectorOpen ? 'Hide details panel' : 'Show details panel'} active={inspectorOpen} onClick={onToggleInspector}>
          <svg aria-hidden width="16" height="14" viewBox="0 0 16 14" fill="none" stroke="currentColor" strokeWidth="1.4">
            <rect x="0.7" y="0.7" width="14.6" height="12.6" rx="2.5" />
            <path d="M10 1v12" />
          </svg>
        </IconButton>
      )}
    </header>
  );
}
