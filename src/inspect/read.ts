// `sigctl read` — time-range and channel-subset retrieval, streamed to stdout.

import type { Recording } from '../store/recover.ts';
import { makeReader } from '../store/reader.ts';
import { parsePosition } from '../util/cli.ts';
import type { Opts } from '../util/cli.ts';
import { n, bytes } from '../util/fmt.ts';

/** "3,17" | "0-7" | "all" | "even" | "odd" */
export function parseChannels(spec: unknown, C: number): number[] {
  const all = Array.from({ length: C }, (_, i) => i);
  if (spec === undefined || spec === 'all') return all;
  if (spec === 'even' || spec === 'odd') return all.filter((i) => i % 2 === (spec === 'even' ? 0 : 1));
  const out = String(spec).split(',').flatMap((part) => {
    const m = part.match(/^(\d+)-(\d+)$/);
    return m ? Array.from({ length: Number(m[2]) - Number(m[1]) + 1 }, (_, i) => Number(m[1]) + i) : [Number(part)];
  });
  return [...new Set(out)].sort((a, b) => a - b);
}

export function read(rec: Recording, opts: Opts): number {
  const { hdr, extent } = rec;
  const rd = makeReader(rec);
  const rate = hdr.sampleRateExactHz;
  const fromFrame = Math.max(0, parsePosition(opts.from, rate) ?? 0);
  const toFrame = Math.min(extent.totalFrames, parsePosition(opts.to, rate) ?? extent.totalFrames);
  const channels = parseChannels(opts.channels, hdr.channelCount);
  const format = String(opts.out ?? 'csv');
  if (toFrame <= fromFrame) {
    process.stderr.write(`error: empty range (${fromFrame}..${toFrame})\n`);
    return 64;
  }

  // Streamed, with EPIPE handled, so `sigctl read | head` ends early instead of filling a dead pipe.
  let broken = false;
  process.stdout.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code !== 'EPIPE') throw e;
    broken = true;
  });
  const write = (s: string | Buffer) => void (!broken && process.stdout.write(s));
  if (format === 'csv') write(`frameIndex,timeSeconds,${channels.map((c) => `ch${c}`).join(',')}\n`);

  // Chunks arrive per block per channel; emit a block once every channel for it has arrived.
  const t0 = process.hrtime.bigint();
  let group = new Map<number, Float32Array>();
  for (const chunk of rd.readRange({ fromFrame, toFrame, channels })) {
    if (broken) break;
    group.set(chunk.channel, Float32Array.from(chunk.data)); // copy: the reader reuses its buffers
    if (group.size < channels.length) continue;
    const cols = channels.map((c) => group.get(c)!);
    group = new Map();
    if (format === 'none') continue;
    if (format === 'raw') {
      for (const col of cols) write(Buffer.from(col.buffer));
      continue;
    }
    for (let j = 0; j < chunk.frameCount; j++) {
      const fi = chunk.startFrameIndex + j;
      const values = cols.map((col) => col[j]);
      write(format === 'jsonl' ? `${JSON.stringify({ frameIndex: fi, timeSeconds: fi / rate, values })}\n` : `${fi},${(fi / rate).toFixed(6)},${values.join(',')}\n`);
    }
  }

  const measured = rd.stats.bytesRead;
  const predicted = rd.predictBytes({ fromFrame, toFrame, channelCount: channels.length });
  const allChannel = rd.predictBytes({ fromFrame, toFrame, channelCount: hdr.channelCount });
  process.stderr.write(
    [
      '',
      `  range          frames ${n(fromFrame)}..${n(toFrame)}  (${((toFrame - fromFrame) / rate).toFixed(3)} s)`,
      `  channels       ${channels.length} of ${hdr.channelCount}`,
      `  bytes read     ${n(measured)}  (${bytes(measured)})   in ${rd.stats.readCalls} read calls`,
      `  predicted      ${n(predicted)}  (§9.2 closed form)  ${measured === predicted ? 'MATCHES' : 'DIFFERS'}`,
      `  all-channel    ${n(allChannel)}  =>  ${(allChannel / measured).toFixed(2)}x fewer bytes read`,
      `  elapsed        ${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1)} ms`,
      '',
      '',
    ].join('\n')
  );
  return 0;
}
