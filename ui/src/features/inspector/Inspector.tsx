import type { FrameInfo, Meta, SeekCost, Validation } from '../../types';
import { VerifySection } from './VerifySection';
import { RecordingSection, HealthSection } from './RecordingSections';
import { DownloadSection } from './DownloadSection';
import { DetailsSection } from './DetailsSection';

/**
 * The side column answers a reviewer's questions in the order they ask them: is it correct (Verify),
 * what is it (Recording), is acquisition healthy (Health), can I take it with me (Download). Technical
 * detail sits behind one disclosure.
 */

export interface InspectorProps {
  meta: Meta;
  info: FrameInfo | null;
  channels: number[];
  windowStart: number;
  windowSeconds: number;
  validation: Validation | null;
  validating: boolean;
  recordingInProgress: boolean;
  onVerify: () => void;
  frameMs: number;
  seekCost: SeekCost | null;
}

export function Inspector(p: InspectorProps) {
  return (
    <div className="flex flex-col">
      <VerifySection validation={p.validation} validating={p.validating} recordingInProgress={p.recordingInProgress} onVerify={p.onVerify} />
      <RecordingSection meta={p.meta} />
      <HealthSection meta={p.meta} info={p.info} />
      <DownloadSection meta={p.meta} channels={p.channels} windowStart={p.windowStart} windowSeconds={p.windowSeconds} />
      <DetailsSection info={p.info} meta={p.meta} frameMs={p.frameMs} seekCost={p.seekCost} />
      <p className="px-5 py-4 text-[12px] text-label-2">Space to play or pause · ← → to skip 10 s</p>
    </div>
  );
}
