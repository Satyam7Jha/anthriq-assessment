#!/usr/bin/env node
'use strict';
// PROCESS C — the inspection and retrieval CLI. PLAN §9, R30–R32, R36.
//
//   sigctl info FILE          metadata inspection (R30)
//   sigctl read FILE          time-range + channel-subset retrieval (R31, R32)
//   sigctl seek FILE          measured seek cost (R36)
//   sigctl hexdump FILE       annotated header dump, for the README
//
// Opens the file O_RDONLY and uses positional reads only, so it shares no state with the recorder,
// cannot block it and cannot corrupt it. That is what makes "readers do not degrade acquisition"
// structural rather than measured.

const fs = require('node:fs');
const { parseArgv, parsePosition } = require('../src/util/cli');
const { openRecording, readLedger, blockOffset } = require('../src/store/recover');
const { makeReader } = require('../src/store/reader');
const fileHeader = require('../src/format/file-header');
const { n, bytes: fmtBytes, duration: fmtDuration } = require('../src/util/fmt');

const USAGE = `
sigctl — inspect and retrieve from a .sigb recording

  node bin/sigctl.js info FILE
  node bin/sigctl.js read FILE [--from T] [--to T] [--channels LIST] [--out FORMAT]
  node bin/sigctl.js seek FILE [--at T]...
  node bin/sigctl.js hexdump FILE

  --from, --to     "12.5s" | "#50000" (frame index) | "1:30" | "250ms"   (default: whole file)
  --channels       "3,17" | "0-7" | "all" | "even"                       (default: all)
  --out            csv | jsonl | raw | none     (default csv; "none" measures cost only)
  --at             seek target for the seek subcommand; repeatable
  --json           machine-readable output where applicable

exit: 0 ok   3 unreadable   64 usage
`;

function parseChannels(spec, C) {
  if (spec === undefined || spec === 'all') return Array.from({ length: C }, (_, i) => i);
  if (spec === 'even') return Array.from({ length: C }, (_, i) => i).filter((i) => i % 2 === 0);
  if (spec === 'odd') return Array.from({ length: C }, (_, i) => i).filter((i) => i % 2 === 1);
  const out = [];
  for (const part of String(spec).split(',')) {
    const m = part.match(/^(\d+)-(\d+)$/);
    if (m) for (let i = Number(m[1]); i <= Number(m[2]); i++) out.push(i);
    else out.push(Number(part));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

function cmdInfo(rec, opts) {
  const { hdr, extent, fileSize, filePath } = rec;
  const ledger = readLedger(rec.fd, hdr, fileSize);
  const sidecarPath = filePath.replace(/\.sigb$/, '') + '.json';
  let sidecar = null;
  let sidecarAgrees = null;
  if (fs.existsSync(sidecarPath)) {
    try {
      sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
      // Conflict rule from docs/FORMAT.md: if the sidecar and the embedded header disagree, the
      // EMBEDDED HEADER WINS and the reader warns. Ambiguity resolved by written policy, not luck.
      sidecarAgrees = sidecar.recordingId === hdr.recordingId;
    } catch {
      sidecarAgrees = false;
    }
  }

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          file: filePath,
          fileSizeBytes: fileSize,
          header: { ...hdr, startTimestampUnixNanos: String(hdr.startTimestampUnixNanos), endTimestampUnixNanos: String(hdr.endTimestampUnixNanos), startMonotonicNanos: String(hdr.startMonotonicNanos) },
          extent: { ...extent, lastBlock: undefined },
          ledger: ledger.entries,
          sidecar: { path: sidecarPath, present: !!sidecar, recordingIdMatches: sidecarAgrees },
        },
        null,
        2
      )}\n`
    );
    return 0;
  }

  const dur = extent.totalFrames / hdr.sampleRateExactHz;
  const rows = [
    ['file', filePath],
    ['size', `${n(fileSize)} B  (${fmtBytes(fileSize)})`],
    ['format', `${hdr.magic} v${hdr.formatVersion}   header ${hdr.headerBytes} B   block header ${hdr.blockHeaderBytes} B`],
    ['recordingId', hdr.recordingId],
    ['', ''],
    ['channelCount', n(hdr.channelCount)],
    ['sampleRateHz', `${n(hdr.sampleRateHz)}  (exact ${hdr.sampleRateExactHz})`],
    ['dataType', `${hdr.dtypeName}  ${hdr.bytesPerValue} bytes/value  ${hdr.endianness === 0x01020304 ? 'little-endian' : 'BIG-ENDIAN'}`],
    ['layout', `${hdr.layoutName}  (planar within a ${n(hdr.framesPerBlock)}-frame block)`],
    ['blockStrideBytes', n(hdr.blockStrideBytes)],
    ['', ''],
    ['totalFrames', n(extent.totalFrames)],
    ['totalValues (samples)', n(extent.totalValues)],
    ['duration', `${dur.toFixed(6)} s   (${fmtDuration(dur)})`],
    ['blockCount', n(extent.blockCount)],
    ['startTimestamp', `${new Date(Number(hdr.startTimestampUnixNanos / 1_000_000n)).toISOString()}  (${hdr.startTimestampUnixNanos} ns unix)`],
    ['endTimestamp', hdr.endTimestampUnixNanos ? new Date(Number(hdr.endTimestampUnixNanos / 1_000_000n)).toISOString() : '(not finalised)'],
    ['', ''],
    ['finalised', hdr.finalised ? 'yes' : 'NO — totals reconstructed from the file length'],
    ['recoveryUsed', extent.recovered ? `yes — ${n(extent.truncatedTailBytes ?? 0)} trailing bytes ignored` : 'no'],
    ['signalId', hdr.signalId],
    ['dither', hdr.ditherDisabled ? 'disabled' : 'enabled'],
    ['ringBytes', `${n(hdr.ringBytes)}  (${(hdr.ringBytes / (hdr.channelCount * hdr.sampleRateExactHz * hdr.bytesPerValue)).toFixed(1)} s of absorption)`],
    ['fsyncInterval', `${hdr.fsyncIntervalSeconds} s  (bounds data at risk on an unclean kill)`],
    ['producer', hdr.producer],
    ['description', hdr.description || '(none)'],
    ['', ''],
    ['droppedFrames', n(hdr.droppedFramesTotal)],
    ['droppedValues', n(hdr.droppedFramesTotal * hdr.channelCount)],
    ['ledgerEntries', `${n(ledger.entries.length)}${hdr.ledgerTruncated ? '  (TRUNCATED — counts exact, positions capped)' : ''}  source: ${ledger.source}`],
    ['sidecar', sidecar ? `${sidecarPath}  recordingId ${sidecarAgrees ? 'matches' : 'DOES NOT MATCH — embedded header wins'}` : '(absent)'],
  ];
  process.stdout.write(rows.map(([k, v]) => (k === '' ? '' : `  ${k.padEnd(22)} ${v}`)).join('\n') + '\n');

  if (ledger.entries.length) {
    process.stdout.write('\n  drop ledger\n');
    for (const e of ledger.entries.slice(0, 20)) {
      process.stdout.write(
        `    frame ${String(n(e.startFrameIndex)).padStart(14)}  +${String(n(e.frameCount)).padStart(10)} frames` +
          `   value #${String(n(e.startFrameIndex * hdr.channelCount)).padStart(15)}` +
          `   t=${(e.startFrameIndex / hdr.sampleRateExactHz).toFixed(3)}s   ${e.cause}\n`
      );
    }
    if (ledger.entries.length > 20) process.stdout.write(`    ... ${ledger.entries.length - 20} more\n`);
  }
  return 0;
}

function cmdRead(rec, opts) {
  const { hdr, extent } = rec;
  const rd = makeReader(rec.fd, hdr, extent);
  const fromFrame = Math.max(0, parsePosition(opts.from, hdr.sampleRateExactHz) ?? 0);
  const toFrame = Math.min(extent.totalFrames, parsePosition(opts.to, hdr.sampleRateExactHz) ?? extent.totalFrames);
  const channels = parseChannels(opts.channels, hdr.channelCount);
  const format = String(opts.out ?? 'csv');
  if (toFrame <= fromFrame) {
    process.stderr.write(`error: empty range (${fromFrame}..${toFrame})\n`);
    return 64;
  }

  const predicted = rd.predictBytes({ fromFrame, toFrame, channelCount: channels.length });
  const t0 = process.hrtime.bigint();

  // The output is STREAMED and EPIPE is handled, so `sigctl read | head` terminates early instead of
  // filling a pipe nobody is reading.
  let broken = false;
  process.stdout.on('error', (e) => {
    if (e.code === 'EPIPE') broken = true;
    else throw e;
  });
  const write = (s) => {
    if (!broken) {
      try {
        process.stdout.write(s);
      } catch (e) {
        if (e.code === 'EPIPE') broken = true;
        else throw e;
      }
    }
  };

  if (format === 'csv') write(`frameIndex,timeSeconds,${channels.map((c) => `ch${c}`).join(',')}\n`);

  // Gather per-block, per-channel chunks and emit them frame-aligned. Only one block's worth of the
  // requested channels is resident at any moment.
  const pending = new Map();
  for (const chunk of rd.readRange({ fromFrame, toFrame, channels })) {
    if (broken) break;
    const key = chunk.startFrameIndex;
    if (!pending.has(key)) pending.set(key, { frameCount: chunk.frameCount, byChannel: new Map() });
    // Copy out: readRange reuses its buffers, which is exactly the trade that keeps memory bounded.
    pending.get(key).byChannel.set(chunk.channel, Float32Array.from(chunk.data));
    const group = pending.get(key);
    if (group.byChannel.size < channels.length) continue;
    pending.delete(key);

    if (format === 'none') continue;
    if (format === 'raw') {
      for (const c of channels) write(Buffer.from(group.byChannel.get(c).buffer.slice(0)));
      continue;
    }
    for (let j = 0; j < group.frameCount; j++) {
      const fi = key + j;
      if (format === 'jsonl') {
        write(
          `${JSON.stringify({
            frameIndex: fi,
            timeSeconds: fi / hdr.sampleRateExactHz,
            values: channels.map((c) => group.byChannel.get(c)[j]),
          })}\n`
        );
      } else {
        write(`${fi},${(fi / hdr.sampleRateExactHz).toFixed(6)},${channels.map((c) => group.byChannel.get(c)[j]).join(',')}\n`);
      }
    }
  }

  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const measured = rd.stats.bytesRead;
  const allChannelBytes = predicted.blocks * hdr.blockStrideBytes;
  process.stderr.write(
    [
      '',
      `  range          frames ${n(fromFrame)}..${n(toFrame)}  (${((toFrame - fromFrame) / hdr.sampleRateExactHz).toFixed(3)} s)`,
      `  channels       ${channels.length} of ${hdr.channelCount}  [${channels.slice(0, 12).join(',')}${channels.length > 12 ? ',…' : ''}]`,
      `  bytes read     ${n(measured)}  (${fmtBytes(measured)})   in ${rd.stats.readCalls} read calls`,
      `  predicted      ${n(predicted.totalBytes)}  (§9.2 closed form)  ${measured === predicted.totalBytes ? 'MATCHES' : 'DIFFERS'}`,
      `  all-channel    ${n(allChannelBytes)}  (${fmtBytes(allChannelBytes)})  =>  ${(allChannelBytes / measured).toFixed(2)}x fewer bytes read`,
      `  subset ratio   ${((channels.length / hdr.channelCount) * 100).toFixed(2)}%  (k/C = ${((channels.length / hdr.channelCount) * 100).toFixed(2)}%)`,
      `  elapsed        ${ms.toFixed(1)} ms     peak RSS ${(process.memoryUsage.rss() / 1048576).toFixed(1)} MiB`,
      '',
    ].join('\n')
  );
  return 0;
}

function cmdSeek(rec, opts) {
  const { hdr, extent } = rec;
  const rd = makeReader(rec.fd, hdr, extent);
  const targets = (Array.isArray(opts.at) ? opts.at : [opts.at ?? '#0'])
    .flatMap((s) => String(s).split(','))
    .map((s) => parsePosition(s, hdr.sampleRateExactHz));
  const results = [];
  for (const f of targets) {
    const before = { bytes: rd.stats.bytesRead, calls: rd.stats.readCalls };
    const t0 = process.hrtime.bigint();
    const hit = rd.findBlock(f);
    const us = Number(process.hrtime.bigint() - t0) / 1000;
    results.push({
      targetFrame: f,
      targetSeconds: f / hdr.sampleRateExactHz,
      found: !!hit,
      blockIndex: hit?.blockIndex ?? null,
      method: hit?.method ?? null,
      probes: hit?.probes ?? 0,
      bytesRead: rd.stats.bytesRead - before.bytes,
      readCalls: rd.stats.readCalls - before.calls,
      microseconds: +us.toFixed(1),
    });
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ hadDrops: hdr.hadDrops, results }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`  seek cost  (file ${hdr.hadDrops ? 'HAS drops — binary search may be needed' : 'is drop-free — closed form applies'})\n\n`);
  process.stdout.write(`    ${'target'.padEnd(16)}${'block'.padEnd(9)}${'method'.padEnd(16)}${'probes'.padEnd(8)}${'bytes'.padEnd(8)}us\n`);
  for (const r of results) {
    process.stdout.write(
      `    ${(`${r.targetSeconds.toFixed(3)}s`).padEnd(16)}${String(r.blockIndex ?? '-').padEnd(9)}` +
        `${String(r.method ?? 'not found').padEnd(16)}${String(r.probes).padEnd(8)}${String(r.bytesRead).padEnd(8)}${r.microseconds}\n`
    );
  }
  return 0;
}

function cmdHexdump(rec) {
  const buf = Buffer.allocUnsafe(fileHeader.HEADER_BYTES);
  fs.readSync(rec.fd, buf, 0, fileHeader.HEADER_BYTES, 0);
  const fields = Object.entries(fileHeader.OFF).sort((a, b) => a[1] - b[1]);
  process.stdout.write('  annotated file header (first 4,096 bytes)\n\n');
  for (let i = 0; i < fields.length; i++) {
    const [name, off] = fields[i];
    const end = i + 1 < fields.length ? fields[i + 1][1] : fileHeader.HEADER_BYTES;
    const len = Math.min(end - off, 32);
    const hex = buf.subarray(off, off + len).toString('hex').replace(/(..)/g, '$1 ').trim();
    process.stdout.write(
      `    ${String(off).padStart(5)}  ${String(end - off).padStart(5)} B  ${name.padEnd(26)}${hex}${end - off > 32 ? ' …' : ''}\n`
    );
  }
  return 0;
}

function main() {
  const { opts, positional } = parseArgv(process.argv.slice(2), { booleans: ['json', 'help', 'quiet'] });
  const [cmd, file] = positional;
  if (opts.help || !cmd) {
    process.stdout.write(USAGE);
    return opts.help ? 0 : 64;
  }
  if (!file) {
    process.stderr.write('error: no file given\n');
    return 64;
  }
  let rec;
  try {
    rec = openRecording(file);
  } catch (e) {
    process.stderr.write(`UNREADABLE: ${e.message}\n`);
    return 3;
  }
  try {
    switch (cmd) {
      case 'info':
        return cmdInfo(rec, opts);
      case 'read':
        return cmdRead(rec, opts);
      case 'seek':
        return cmdSeek(rec, opts);
      case 'hexdump':
        return cmdHexdump(rec);
      default:
        process.stderr.write(`unknown subcommand ${JSON.stringify(cmd)}\n${USAGE}`);
        return 64;
    }
  } finally {
    rec.close();
  }
}

process.exitCode = main();
