import type { FrameInfo, Meta, SeekCost, Validation } from '../../types';
import { VerifySection } from './VerifySection';
import { RecordingSection, HealthSection } from './RecordingSections';
import { ChannelsSection } from './ChannelsSection';
import { DownloadSection } from './DownloadSection';
import { DetailsSection } from './DetailsSection';

/**
 * Answers a reviewer's questions in the order they ask them: is it correct (Verify), what is it
 * (Recording), is acquisition healthy (Health), how much am I looking at (Channels), can I take it with
 * me (Download). Technical detail sits behind one disclosure.
 */

export interface InspectorProps {
  meta: Meta;
  info: FrameInfo | null;
  shown: number;
  onShown: (count: number) => void;
  channels: number[];
  windowStart: number;
  windowSeconds: number;
  validation: Validation | null;
  validating: boolean;
  verifyAutomatically: boolean;
  onVerify: () => void;
  frameMs: number;
  seekCost: SeekCost | null;
}

export function Inspector(p: InspectorProps) {
  return (
    <div className="flex flex-col gap-6 px-5 py-6">
      <VerifySection validation={p.validation} validating={p.validating} automatic={p.verifyAutomatically} onVerify={p.onVerify} />
      <RecordingSection meta={p.meta} info={p.info} />
      <HealthSection meta={p.meta} info={p.info} />
      <ChannelsSection meta={p.meta} info={p.info} shown={p.shown} onShown={p.onShown} />
      <DownloadSection meta={p.meta} channels={p.channels} windowStart={p.windowStart} windowSeconds={p.windowSeconds} />
      <DetailsSection meta={p.meta} info={p.info} frameMs={p.frameMs} seekCost={p.seekCost} />
      <p className="px-4 text-[12px] text-label-2">Space to play or pause · ← → to skip 10 s</p>
    </div>
  );
}
