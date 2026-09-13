import { ListRow } from '../../components/ui';
import { fmtBytes } from '../../lib/format';
import type { FrameInfo, Meta, SeekCost } from '../../types';

/** Technical detail for whoever wants it, closed by default. A native <details>, so it is accessible for free. */
export function DetailsSection({ meta, info, frameMs, seekCost }: { meta: Meta; info: FrameInfo | null; frameMs: number; seekCost: SeekCost | null }) {
  const exact = info ? info.bytesRead === info.predictedBytes : null;
  const saving = info && info.bytesRead > 0 ? info.allChannelBytes / info.bytesRead : 1;
  return (
    <details className="group border-b border-line">
      <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-[14px] font-semibold text-label transition hover:bg-subtle [&::-webkit-details-marker]:hidden">
        Technical details
        <svg aria-hidden width="8" height="8" viewBox="0 0 8 8" className="text-label-3 transition-transform group-open:rotate-90" fill="currentColor">
          <path d="M2 1l4 3-4 3z" />
        </svg>
      </summary>
      <div className="pb-4">
        <ListRow label="Sample format" value={`${meta.dtype}, 1 s planar blocks`} />
        <ListRow label="Read per screen update" value={info ? `${fmtBytes(info.bytesRead)}${exact ? ', as predicted' : ''}` : '—'} />
        <ListRow label="Saved by reading fewer channels" value={saving > 1.05 ? `${saving.toFixed(1)}× less data` : '—'} />
        <ListRow label="Last seek" value={seekCost ? `${seekCost.microseconds} µs, ${fmtBytes(seekCost.bytesRead)} read` : '—'} />
        <ListRow label="Chart draw time" value={`${frameMs.toFixed(2)} ms`} last />
        <p className="mt-2 px-5 text-[12px] leading-snug text-label-2">
          Only the blocks and channels on screen are read. A seek reads one 64-byte block header, however long the recording.
        </p>
      </div>
    </details>
  );
}
