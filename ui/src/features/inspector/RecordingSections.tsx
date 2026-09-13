import { ListGroup, ListRow } from '../../components/ui';
import { fmtBytes, fmtInt } from '../../lib/format';
import type { FrameInfo, Meta } from '../../types';

/** What the recording is. Duration and sample counts live in the stats strip above the chart. */
export function RecordingSection({ meta }: { meta: Meta }) {
  return (
    <ListGroup title="Recording">
      <ListRow label="Status" value={meta.finalised ? 'Saved' : 'Being written'} />
      <ListRow label="File" value={meta.file} />
      <ListRow label="Channels" value={meta.channelCount} />
      <ListRow label="Sample rate" value={`${fmtInt(meta.sampleRateHz)} Hz per channel`} />
      <ListRow label="Size on disk" value={fmtBytes(meta.fileSizeBytes)} last />
    </ListGroup>
  );
}

/**
 * How acquisition behaved. Loss is shown as time and gaps, not a raw sample count: "1 h 42 min in 6
 * gaps" is something a person can reason about; the markers carry the exact positions on the timeline.
 */
export function HealthSection({ meta, info }: { meta: Meta; info: FrameInfo | null }) {
  const gaps = meta.markers.length;
  const h = info?.recorder;
  const footer = gaps
    ? 'Gaps are stretches where acquisition could not run, for example while the computer slept or the disk stalled. Each is marked in red on the timeline.'
    : h
      ? 'The buffer is the recorder’s reserve for a slow disk; samples are dropped only if it fills. Memory stays flat however long you record.'
      : 'This file was opened directly, so there is no live recorder to report on.';
  return (
    <ListGroup title="Health" footer={footer}>
      {h ? (
        <>
          <ListRow label="Buffer used" value={`${h.ringFillPct.toFixed(1)}%`} />
          <ListRow label="Slowest disk write" value={`${h.writeLatencyMaxMs.toFixed(1)} ms`} />
          <ListRow label="Recorder memory" value={fmtBytes(h.rssBytes)} last />
        </>
      ) : (
        <ListRow label="Recorder telemetry" value="Not available" last />
      )}
    </ListGroup>
  );
}
