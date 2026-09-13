// Downloads: the recording exactly as recorded, its metadata sidecar, and a window of samples as CSV.
//
// Each download opens the file itself instead of borrowing the live view: while a recording is being
// written the view re-opens it several times a second, closing the old descriptor, and a download can
// take longer than that. The CSV is capped in duration, built one block at a time, and waits for the
// socket to drain, so its memory is one block of text however slow the client is.

import fs from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { openRecording } from '../store/recover.ts';
import { makeReader } from '../store/reader.ts';

export const CSV_MAX_SECONDS = 60;

/** A request that cannot be served in the recording's current state; the message is shown to the user. */
export class DownloadRefused extends Error {}

const sidecarPathFor = (file: string) => file.replace(/\.sigb$/, '') + '.json';

function attachment(res: ServerResponse, filename: string, type: string, size?: number): void {
  res.writeHead(200, {
    'content-type': type,
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
    ...(size === undefined ? {} : { 'content-length': String(size) }),
  });
}

/** Resolves when the socket can take more, or has gone away. */
function drained(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

/** Nine significant digits are enough to round-trip any float32. */
const f32 = (x: number): string => String(Number(x.toPrecision(9)));

/** The .sigb file, byte for byte. Refused while it is still being written, since it would end mid-block. */
export function sendRecording(filePath: string, res: ServerResponse): void {
  const rec = openRecording(filePath);
  const { finalised } = rec.hdr;
  rec.close();
  if (!finalised) throw new DownloadRefused('The recording is still being written. Stop it first.');
  attachment(res, path.basename(filePath), 'application/octet-stream', fs.statSync(filePath).size);
  fs.createReadStream(filePath).pipe(res);
}

export function sendMetadata(filePath: string, res: ServerResponse): void {
  const sidecar = sidecarPathFor(filePath);
  if (!fs.existsSync(sidecar)) throw new DownloadRefused('Metadata is written when the recording is saved.');
  attachment(res, path.basename(sidecar), 'application/json', fs.statSync(sidecar).size);
  fs.createReadStream(sidecar).pipe(res);
}

/** Rows of `time_s,frame,channel_1,…` for [fromSeconds, fromSeconds + seconds), channels numbered from 1. */
export async function sendCsv(filePath: string, res: ServerResponse, q: { fromSeconds: number; seconds: number; channels: number[] }): Promise<void> {
  const rec = openRecording(filePath);
  try {
    const { hdr, extent } = rec;
    const rate = hdr.sampleRateExactHz;
    const channels = [...new Set(q.channels)].filter((c) => Number.isInteger(c) && c >= 0 && c < hdr.channelCount).sort((a, b) => a - b);
    if (channels.length === 0) throw new DownloadRefused('Choose at least one channel.');
    const seconds = Math.min(Math.max(Number(q.seconds) || 0, 0), CSV_MAX_SECONDS);
    const fromFrame = Math.max(0, Math.min(Math.round((Number(q.fromSeconds) || 0) * rate), extent.endFrame));
    const toFrame = Math.min(extent.endFrame, fromFrame + Math.round(seconds * rate));
    if (toFrame <= fromFrame) throw new DownloadRefused('That window contains no samples.');

    attachment(res, `${path.basename(filePath, '.sigb')}_frames-${fromFrame}-${toFrame}.csv`, 'text/csv; charset=utf-8');
    res.write(`time_s,frame,${channels.map((c) => `channel_${c + 1}`).join(',')}\n`);

    // Chunks arrive per block per channel; a block becomes rows once every channel for it has arrived.
    const reader = makeReader(rec);
    const columns = channels.map(() => new Float32Array(hdr.framesPerBlock));
    let arrived = 0;
    for (const chunk of reader.readRange({ fromFrame, toFrame, channels })) {
      columns[channels.indexOf(chunk.channel)].set(chunk.data);
      if (++arrived < channels.length) continue;
      arrived = 0;
      let text = '';
      for (let j = 0; j < chunk.frameCount; j++) {
        const frame = chunk.startFrameIndex + j;
        text += `${(frame / rate).toFixed(6)},${frame}`;
        for (const column of columns) text += `,${f32(column[j])}`;
        text += '\n';
      }
      if (!res.write(text)) await drained(res);
      if (res.destroyed) return;
    }
    res.end();
  } finally {
    rec.close();
  }
}
