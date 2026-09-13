import { ListRow } from '../../components/ui';
import { fmtBytes } from '../../lib/format';
import type { FrameInfo, Meta, SeekCost } from '../../types';

/** Technical detail for whoever wants it, closed by default. A native <details>, so it is accessible for free. */
export function DetailsSection({ meta, info, frameMs, seekCost }: { meta: Meta; info: FrameInfo | null; frameMs: number; seekCost: SeekCost | null }) {
  const exact = info ? info.bytesRead === info.predictedBytes : null;
  return (
    <details className="group">
      <summary className="flex cursor-default list-none items-center gap-1.5 px-4 text-[12px] font-medium text-label-2">
        <svg aria-hidden width="8" height="8" viewBox="0 0 8 8" className="transition-transform group-open:rotate-90" fill="currentColor">
          <path d="M2 1l4 3-4 3z" />
        </svg>
        Details
      </summary>
      <div className="mt-2 overflow-hidden rounded-xl bg-surface">
        <ListRow label="File" value={meta.file} />
        <ListRow label="Size" value={fmtBytes(meta.fileSizeBytes)} />
        <ListRow label="Format" value={`${meta.dtype}, planar blocks`} />
        <ListRow label="Bytes read per frame" value={info ? `${fmtBytes(info.bytesRead)}${exact ? ' · as predicted' : ''}` : '—'} />
        <ListRow label="Last seek" value={seekCost ? `${seekCost.microseconds} µs · ${seekCost.method}` : '—'} />
        <ListRow label="Draw time" value={`${frameMs.toFixed(2)} ms`} last />
      </div>
    </details>
  );
}
