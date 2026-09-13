// `sigctl seek` — measured seek cost (R36) — and `sigctl hexdump`, an annotated header for the README.

import fs from 'node:fs';
import type { Recording } from '../store/recover.ts';
import { makeReader } from '../store/reader.ts';
import { parsePosition } from '../util/cli.ts';
import type { Opts } from '../util/cli.ts';
import * as fileHeader from '../format/file-header.ts';

export function seek(rec: Recording, opts: Opts): number {
  const { hdr } = rec;
  const rd = makeReader(rec);
  const targets = String(opts.at ?? '#0').split(',').map((s) => parsePosition(s, hdr.sampleRateExactHz) ?? 0);
  const results = targets.map((frame) => {
    const before = rd.stats.bytesRead;
    const t0 = process.hrtime.bigint();
    const hit = rd.findBlock(frame);
    return {
      seconds: frame / hdr.sampleRateExactHz,
      blockIndex: hit?.blockIndex ?? null,
      method: hit?.method ?? 'not found',
      probes: hit?.probes ?? 0,
      bytesRead: rd.stats.bytesRead - before,
      microseconds: +(Number(process.hrtime.bigint() - t0) / 1000).toFixed(1),
    };
  });
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ hadDrops: hdr.hadDrops, results }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`  seek cost (${hdr.hadDrops ? 'recording has drops — binary search may apply' : 'drop-free — closed form applies'})\n\n`);
  process.stdout.write(`    ${'target'.padEnd(14)}${'block'.padEnd(8)}${'method'.padEnd(16)}${'probes'.padEnd(8)}${'bytes'.padEnd(8)}us\n`);
  for (const r of results) {
    process.stdout.write(`    ${`${r.seconds.toFixed(3)}s`.padEnd(14)}${String(r.blockIndex ?? '-').padEnd(8)}${r.method.padEnd(16)}${String(r.probes).padEnd(8)}${String(r.bytesRead).padEnd(8)}${r.microseconds}\n`);
  }
  return 0;
}

export function hexdump(rec: Recording): number {
  const buf = Buffer.allocUnsafe(fileHeader.HEADER_BYTES);
  fs.readSync(rec.fd, buf, 0, fileHeader.HEADER_BYTES, 0);
  const fields = Object.entries(fileHeader.OFF).sort((a, b) => a[1] - b[1]);
  process.stdout.write('  annotated file header (first 4,096 bytes)\n\n');
  fields.forEach(([name, off], i) => {
    const end = fields[i + 1]?.[1] ?? fileHeader.HEADER_BYTES;
    const hex = buf.subarray(off, off + Math.min(end - off, 32)).toString('hex').replace(/(..)/g, '$1 ').trim();
    process.stdout.write(`    ${String(off).padStart(5)}  ${String(end - off).padStart(5)} B  ${name.padEnd(26)}${hex}${end - off > 32 ? ' …' : ''}\n`);
  });
  return 0;
}
