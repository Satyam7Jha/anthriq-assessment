import { ListGroup, ListRow } from '../../components/ui';
import { fmtBytes, fmtDuration, fmtInt, fmtTime } from '../../lib/format';
import type { FrameInfo, Meta } from '../../types';

export function RecordingSection({ meta, info }: { meta: Meta; info: FrameInfo | null }) {
  const frames = info?.totalFrames ?? meta.totalFrames;
  const end = info?.endFrame ?? meta.endFrame;
  return (
    <ListGroup title="Recording">
      <ListRow label="Channels" value={meta.channelCount} />
      <ListRow label="Sample rate" value={`${fmtInt(meta.sampleRateHz)} Hz`} />
      <ListRow label="Duration" value={fmtTime(end / meta.sampleRateHz)} />
      <ListRow label="Samples" value={fmtInt(frames * meta.channelCount)} last />
    </ListGroup>
  );
}

/**
 * Loss is shown as time and gaps, not a raw sample count: "1 h 42 min in 6 gaps" is something a person
 * can reason about; "781,480,960" is not. The markers carry the exact positions on the timeline.
 */
export function HealthSection({ meta, info }: { meta: Meta; info: FrameInfo | null }) {
  const lostSeconds = meta.markers.reduce((sum, m) => sum + m.durationSeconds, 0);
  const gaps = meta.markers.length;
  const h = info?.recorder;
  return (
    <ListGroup title="Health" footer={gaps > 0 ? 'Gaps are stretches where acquisition could not run — for example while the computer was asleep or the disk stalled. Each one is marked on the timeline.' : undefined}>
      <ListRow label="Lost" value={gaps ? `${fmtDuration(lostSeconds)} in ${gaps} gap${gaps === 1 ? '' : 's'}` : 'Nothing'} tone={gaps ? 'red' : undefined} last={!h} />
      {h && (
        <>
          <ListRow label="Buffer used" value={`${h.ringFillPct.toFixed(1)}%`} />
          <ListRow label="Slowest write" value={`${h.writeLatencyMaxMs.toFixed(1)} ms`} />
          <ListRow label="Recorder memory" value={fmtBytes(h.rssBytes)} last />
        </>
      )}
    </ListGroup>
  );
}
