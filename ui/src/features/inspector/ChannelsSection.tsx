import { ListGroup, SegmentedControl } from '../../components/ui';
import type { FrameInfo, Meta } from '../../types';

/** How many channels to show, spread evenly across the montage. Fewer channels = fewer bytes read. */
export function ChannelsSection({ meta, info, shown, onShown }: { meta: Meta; info: FrameInfo | null; shown: number; onShown: (n: number) => void }) {
  const C = meta.channelCount;
  const options = [C, 16, 8, 4].filter((n, i, all) => n <= C && all.indexOf(n) === i).map((n) => ({ value: String(n), label: n === C ? 'All' : String(n) }));
  const saving = info && info.bytesRead > 0 ? info.allChannelBytes / info.bytesRead : 1;
  return (
    <ListGroup title="Channels shown" footer={saving > 1.05 ? `Only these channels are read from disk — ${saving.toFixed(1)}× less data.` : undefined}>
      <div className="p-2">
        <SegmentedControl label="Channels shown" options={options} value={String(Math.min(shown, C))} onChange={(v) => onShown(Number(v))} />
      </div>
    </ListGroup>
  );
}
