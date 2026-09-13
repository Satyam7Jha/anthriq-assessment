import { ListGroup, ListLink } from '../../components/ui';
import { api } from '../../api/client';
import { fmtBytes, fmtTime } from '../../lib/format';
import type { Meta } from '../../types';

const FORMAT_SPEC = 'https://github.com/Satyam7Jha/anthriq-assessment/blob/main/docs/FORMAT.md';

/** CSV row cost: a time and frame column, then roughly twelve characters per sample. */
const csvBytes = (seconds: number, rate: number, channels: number) => Math.round(seconds * rate * (22 + channels * 12));

/** Everything the viewer shows can leave it: the file as recorded, its metadata, and the samples on screen. */
export function DownloadSection({ meta, channels, windowStart, windowSeconds }: { meta: Meta; channels: number[]; windowStart: number; windowSeconds: number }) {
  const saved = meta.finalised;
  const seconds = Math.min(windowSeconds, meta.limits.csvMaxSeconds, Math.max(0, meta.endFrame / meta.sampleRateHz - windowStart));
  return (
    <ListGroup
      title="Download"
      footer={
        <>
          The recording is self-describing: its header states every parameter needed to read it, as specified in{' '}
          <a href={FORMAT_SPEC} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            FORMAT.md
          </a>
          .
        </>
      }
    >
      <ListLink
        href={api.downloads.recording}
        title="Recording"
        detail={saved ? `.sigb · ${fmtBytes(meta.fileSizeBytes)} · every sample, as recorded` : 'Available once the recording is saved'}
        disabled={!saved}
      />
      <ListLink href={api.downloads.metadata} title="Metadata" detail={saved ? '.json · settings, timing and drop log' : 'Available once the recording is saved'} disabled={!saved} />
      <ListLink
        href={api.downloads.csv({ fromSeconds: windowStart, seconds, channels })}
        title="Samples on screen"
        detail={
          seconds > 0
            ? `.csv · ${fmtTime(windowStart)}–${fmtTime(windowStart + seconds)} · ${channels.length} channel${channels.length === 1 ? '' : 's'} · about ${fmtBytes(csvBytes(seconds, meta.sampleRateHz, channels.length))}`
            : 'Nothing on screen yet'
        }
        disabled={seconds <= 0 || channels.length === 0}
        last
      />
    </ListGroup>
  );
}
