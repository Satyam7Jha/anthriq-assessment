#!/usr/bin/env node
'use strict';
// PROCESS E — the UI server. PLAN §11.3.
//
// THE STRUCTURAL GUARANTEE (R46): this process NEVER connects to the acquisition socket and NEVER
// talks to the recorder. It opens the .sigb file O_RDONLY and uses positional reads. Consequences,
// each of which is an argument rather than a hope:
//   - it CANNOT exert backpressure on the recorder: there is no channel through which to do so;
//   - it CANNOT block the recorder: pread on a separate fd does not contend with append-only writes
//     beyond page-cache sharing, and the blocks it reads were committed seconds ago;
//   - if the UI is slow, crashes, or is never started, the recording is BIT-IDENTICAL. That is
//     provable by SHA-256 rather than arguable by percentage deltas.
//
// The price, stated plainly: ~1.1 s of display latency, because the UI follows COMMITTED FILE BLOCKS
// rather than the live socket. That is deliberate. A lower-latency variant would need a second
// consumer on the generator's write path, which is precisely the coupling R11 forbids.
//
// Decimation happens HERE, not in the browser: 2*width floats per channel instead of 4,000 per
// channel-second, a ~200x reduction in bytes crossing the boundary.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseArgv } = require('../src/util/cli');
const { openRecording, readLedger } = require('../src/store/recover');
const { makeReader } = require('../src/store/reader');
const { envelope, quality } = require('../src/viz/decimate');
const { createLogger } = require('../src/util/logger');
const D = require('../src/config/defaults');

const USAGE = `
sigacq uiserver — PROCESS E (read-only)

  node bin/uiserver.js --follow FILE.sigb [--port ${D.UI_PORT}]

  --follow PATH    recording to view. Works on a LIVE file being written.
  --port N         HTTP port (default ${D.UI_PORT})
  --stats PATH     recorder stats NDJSON to tail for the health panel
                   (defaults to <file>.stats.ndjson if present)
  --help
`;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.map': 'application/json', '.ico': 'image/x-icon' };

function main() {
  const { opts, positional } = parseArgv(process.argv.slice(2), { booleans: ['help'] });
  if (opts.help) return void process.stdout.write(USAGE);
  const file = opts.follow ?? positional[0];
  if (!file) {
    process.stderr.write(USAGE);
    process.exit(64);
  }
  const filePath = path.resolve(String(file));
  const port = Number(opts.port ?? D.UI_PORT);
  const log = createLogger({ component: 'uiserver' });
  const statsPath = opts.stats ? String(opts.stats) : filePath.replace(/\.sigb$/, '') + '.stats.ndjson';

  // ---- a fresh read-only view of the file, re-resolved as it grows -----------------------------
  // Reopening per request is deliberate: a LIVE file's extent changes, and the recovery path
  // (PLAN §8.6) is what computes the currently-committed extent. Using it on every request means
  // the crash-recovery code is exercised continuously rather than only after a crash.
  let cached = null;
  let cachedAt = 0;
  function view(maxAgeMs = 200) {
    const now = Date.now();
    if (cached && now - cachedAt < maxAgeMs) return cached;
    cached?.close();
    cached = openRecording(filePath);
    cached.reader = makeReader(cached.fd, cached.hdr, cached.extent);
    cachedAt = now;
    return cached;
  }

  // Buffers reused across requests (F-06). The previous version allocated a fresh Float32Array per
  // channel per push — ~100 MB/s of garbage at 32 channels and a 10 s window.
  let scratch = new Float32Array(0);
  let envOut = new Float32Array(0);

  /**
   * Decimate a window to min/max envelopes, in ONE reader pass.
   * Returns { info, body } where body is the binary frame the browser receives:
   *   [u32 jsonBytes][json, space-padded to a 4-byte boundary][float32 envelopes]
   * Envelopes are channels.length x columns x 2 floats, in request order, [min, max] per column.
   * NaN marks a column with no data. Binary, so the browser takes a Float32Array view over the
   * response — no base64, no per-byte decode loop, nothing for a Worker to do.
   */
  function windowFrame({ fromFrame, toFrame, channels, columns, spanFrames = toFrame - fromFrame }) {
    const v = view();
    const { hdr, extent } = v;
    const from = Math.max(0, Math.min(fromFrame, extent.totalFrames));
    const to = Math.max(from, Math.min(toFrame, extent.totalFrames));
    const frames = to - from;
    const cols = Math.max(1, Math.min(columns, 4096));
    const C = channels.length;

    if (scratch.length < frames * C) scratch = new Float32Array(frames * C);
    if (envOut.length < C * cols * 2) envOut = new Float32Array(C * cols * 2);
    envOut.fill(NaN, 0, C * cols * 2);
    const filled = new Int32Array(C);
    const slotOf = new Map(channels.map((c, k) => [c, k]));

    // Clear to NaN, not zero: this buffer is reused, and a region the reader does not fill is lost
    // data. Leaving the previous request's values there drew flat lines straight through gaps.
    if (frames > 0) scratch.fill(NaN, 0, frames * C);
    const bytesBefore = v.reader.stats.bytesRead;
    if (frames > 0) {
      for (const chunk of v.reader.readRange({ fromFrame: from, toFrame: to, channels })) {
        const k = slotOf.get(chunk.channel);
        const at = chunk.startFrameIndex - from;
        if (k === undefined || at < 0 || at + chunk.frameCount > frames) continue;
        scratch.set(chunk.data.subarray(0, chunk.frameCount), k * frames + at);
        filled[k] = Math.max(filled[k], at + chunk.frameCount);
      }
    }

    const quality = {};
    for (let k = 0; k < C; k++) {
      if (filled[k] === 0) continue;
      const src = scratch.subarray(k * frames, k * frames + filled[k]);
      // Decimate the filled prefix into the columns it covers, so a partly-filled live window is
      // drawn at the right place on the time axis rather than stretched across it.
      // Relative to the REQUESTED span, not the clamped one: while a live recording is shorter than
      // the window, its data must occupy only the left part of the axis rather than being stretched.
      const usedCols = Math.max(1, Math.min(cols, Math.round((filled[k] / Math.max(1, spanFrames)) * cols)));
      const stats = envelope(src, usedCols, envOut.subarray(k * cols * 2, k * cols * 2 + usedCols * 2));
      quality[channels[k]] = quality_(stats);
    }

    const info = {
      from,
      to,
      frames,
      columns: cols,
      channels,
      quality,
      sampleRateHz: hdr.sampleRateExactHz,
      totalFrames: extent.totalFrames,
      finalised: hdr.finalised,
      bytesRead: v.reader.stats.bytesRead - bytesBefore,
      predictedBytes: frames ? v.reader.predictBytes({ fromFrame: from, toFrame: to, channelCount: C }).totalBytes : 0,
      allChannelBytes: frames ? v.reader.predictBytes({ fromFrame: from, toFrame: to, channelCount: hdr.channelCount }).totalBytes : 0,
    };
    return { info, envBytes: C * cols * 2 * 4 };
  }

  function quality_(stats) {
    return { ...quality(stats), samplesPerColumn: +stats.samplesPerColumn.toFixed(1) };
  }

  function meta() {
    const v = view(0);
    const ledger = readLedger(v.fd, v.hdr, v.fileSize);
    return {
      file: path.basename(filePath),
      path: filePath,
      fileSizeBytes: v.fileSize,
      channelCount: v.hdr.channelCount,
      sampleRateHz: v.hdr.sampleRateExactHz,
      framesPerBlock: v.hdr.framesPerBlock,
      blockStrideBytes: v.hdr.blockStrideBytes,
      dtype: v.hdr.dtypeName,
      bytesPerValue: v.hdr.bytesPerValue,
      layout: v.hdr.layoutName,
      totalFrames: v.extent.totalFrames,
      totalValues: v.extent.totalValues,
      durationSeconds: v.extent.totalFrames / v.hdr.sampleRateExactHz,
      finalised: v.hdr.finalised,
      recovered: v.extent.recovered,
      hadDrops: v.hdr.hadDrops,
      signalId: v.hdr.signalId,
      ditherDisabled: v.hdr.ditherDisabled,
      startTimestampUnixNanos: String(v.hdr.startTimestampUnixNanos),
      recordingId: v.hdr.recordingId,
      producer: v.hdr.producer,
      ringBytes: v.hdr.ringBytes,
      ringSeconds: v.hdr.ringBytes / (v.hdr.channelCount * v.hdr.sampleRateExactHz * v.hdr.bytesPerValue),
      // Markers, in the EDF+ annotation shape (onset, duration, label, kind) — PLAN §11.10.
      markers: ledger.entries.map((e) => ({
        kind: e.cause === 'PACING_RESYNC' ? 'RESYNC' : 'GAP',
        onsetSeconds: e.startFrameIndex / v.hdr.sampleRateExactHz,
        durationSeconds: e.frameCount / v.hdr.sampleRateExactHz,
        startFrameIndex: e.startFrameIndex,
        frameCount: e.frameCount,
        label: `${e.cause} — ${(e.frameCount * v.hdr.channelCount).toLocaleString('en-US')} values`,
      })),
      droppedFrames: v.hdr.droppedFramesTotal,
      droppedValues: v.hdr.droppedFramesTotal * v.hdr.channelCount,
    };
  }

  /** Tail the recorder's stats NDJSON — read-only, like everything else here. */
  function health() {
    if (!fs.existsSync(statsPath)) return null;
    const size = fs.statSync(statsPath).size;
    const want = Math.min(size, 8192);
    const fd = fs.openSync(statsPath, 'r');
    try {
      const buf = Buffer.allocUnsafe(want);
      fs.readSync(fd, buf, 0, want, size - want);
      const lines = buf.toString('utf8').trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          return JSON.parse(lines[i]);
        } catch {
          /* a partially-written trailing line; try the one before */
        }
      }
      return null;
    } finally {
      fs.closeSync(fd);
    }
  }

  // ---- transport state (PLAN §9.5 state machine, driven over HTTP) ------------------------------
  // Paced on the MONOTONIC clock (F-05). Date.now() is a wall clock and steps under NTP; a playback
  // cursor derived from it would jump. Pause/resume/seek re-anchor, so elapsed paused time is not owed.
  const nowNs = () => process.hrtime.bigint();
  const transport = { state: 'PAUSED', cursorFrame: 0, rateMultiplier: 1, anchorNs: nowNs(), anchorFrame: 0, mode: 'live' };

  function transportPosition() {
    if (transport.state !== 'PLAYING') return transport.cursorFrame;
    const v = view();
    const elapsed = Number(nowNs() - transport.anchorNs) / 1e9;
    const f = transport.anchorFrame + Math.floor(elapsed * v.hdr.sampleRateExactHz * transport.rateMultiplier);
    return Math.max(0, Math.min(f, v.extent.totalFrames));
  }

  function applyTransport(cmd) {
    const v = view();
    const reanchor = (frame) => {
      // Re-anchoring is the deliberate difference between playback and acquisition (PLAN §9.5):
      // after a pause or a seek, the elapsed wall time is NOT owed, so the clock restarts here.
      transport.cursorFrame = frame;
      transport.anchorFrame = frame;
      transport.anchorNs = nowNs();
    };
    switch (cmd.op) {
      case 'play':
        reanchor(transportPosition());
        transport.state = 'PLAYING';
        break;
      case 'pause':
        reanchor(transportPosition());
        transport.state = 'PAUSED';
        break;
      case 'rate':
        reanchor(transportPosition());
        transport.rateMultiplier = Math.max(0.05, Math.min(16, Number(cmd.multiplier) || 1));
        break;
      case 'seek': {
        const target = Math.max(0, Math.min(Number(cmd.frame) || 0, v.extent.totalFrames));
        // Measure the real seek cost and hand it back, so the UI can DISPLAY it. That is how R36's
        // "cost documented" becomes visible rather than asserted.
        const before = { bytes: v.reader.stats.bytesRead, calls: v.reader.stats.readCalls };
        const t0 = process.hrtime.bigint();
        const hit = v.reader.findBlock(target);
        const us = Number(process.hrtime.bigint() - t0) / 1000;
        reanchor(target);
        return {
          ...publicTransport(),
          seekCost: {
            microseconds: +us.toFixed(1),
            bytesRead: v.reader.stats.bytesRead - before.bytes,
            readCalls: v.reader.stats.readCalls - before.calls,
            method: hit?.method ?? 'not-found',
            probes: hit?.probes ?? 0,
          },
        };
      }
      case 'mode':
        transport.mode = cmd.mode === 'review' ? 'review' : 'live';
        break;
      default:
        break;
    }
    return publicTransport();
  }

  function publicTransport() {
    const { anchorNs, ...rest } = transport; // BigInt does not serialise, and the client needs no anchor
    return { ...rest, position: transportPosition() };
  }

  // ---- HTTP ------------------------------------------------------------------------------------
  const DIST = path.join(__dirname, '..', 'ui', 'dist');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };

    try {
      if (url.pathname === '/api/meta') return send(200, meta());
      if (url.pathname === '/api/health') return send(200, { recorder: health(), statsPath, present: fs.existsSync(statsPath) });

      if (url.pathname === '/api/frame') {
        // The browser PULLS frames: it asks for the next one when it has drawn the last. A slow
        // client therefore asks less often instead of accumulating a server-side backlog, which is
        // the same "no hidden queue" rule the acquisition path follows.
        const q = url.searchParams;
        const v = view();
        const channels = (q.get('channels') ?? '')
          .split(',')
          .filter(Boolean)
          .map(Number)
          .filter((c) => Number.isInteger(c) && c >= 0 && c < v.hdr.channelCount);
        const columns = Number(q.get('columns') ?? 1000);
        const span = Math.max(1, Math.round(Number(q.get('seconds') ?? 10) * v.hdr.sampleRateExactHz));
        const from =
          transport.mode === 'live'
            ? Math.max(0, v.extent.totalFrames - span)
            : Math.max(0, Math.min(transportPosition() - Math.floor(span / 2), v.extent.totalFrames - span));
        const { info, envBytes } = windowFrame({ fromFrame: from, toFrame: from + span, channels, columns, spanFrames: span });
        info.transport = publicTransport();
        info.recorder = health();
        let json = Buffer.from(JSON.stringify(info));
        const pad = (4 - ((4 + json.length) % 4)) % 4;
        if (pad) json = Buffer.concat([json, Buffer.alloc(pad, 0x20)]);
        const head = Buffer.allocUnsafe(4);
        head.writeUInt32LE(json.length, 0);
        const env = Buffer.from(envOut.buffer, envOut.byteOffset, envBytes);
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'content-length': 4 + json.length + envBytes });
        res.end(Buffer.concat([head, json, env]));
        return undefined;
      }

      if (url.pathname === '/api/transport' && req.method === 'POST') {
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', () => {
          try {
            send(200, applyTransport(JSON.parse(body || '{}')));
          } catch (e) {
            send(400, { error: e.message });
          }
        });
        return undefined;
      }

      if (url.pathname === '/api/validate' && req.method === 'POST') {
        // Spawned as a SEPARATE PROCESS, for the same reason everything else here is: the
        // validator's independence is the property that makes its verdict worth anything, and the
        // UI must not be able to influence it.
        const child = spawn('node', [path.join(__dirname, 'sigval.js'), filePath, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (err += d));
        child.on('close', (code) => {
          let parsed = null;
          try {
            parsed = JSON.parse(out);
          } catch {
            /* validator refused before producing JSON; exitCode + stderr tell the story */
          }
          send(200, { exitCode: code, report: parsed, stderr: err.slice(-2000) });
        });
        return undefined;
      }

      // --- static files ---
      let p = url.pathname === '/' ? '/index.html' : url.pathname;
      const filePathOnDisk = path.join(DIST, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (!filePathOnDisk.startsWith(DIST)) return send(403, { error: 'forbidden' });
      if (!fs.existsSync(filePathOnDisk)) {
        return send(404, `not found: ${p}\n\nRun "npm run ui:build" first.\n`, 'text/plain; charset=utf-8');
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(filePathOnDisk)] ?? 'application/octet-stream' });
      fs.createReadStream(filePathOnDisk).pipe(res);
      return undefined;
    } catch (e) {
      log.error('request-failed', { path: url.pathname, message: e.message });
      return send(500, { error: e.message });
    }
  });

  server.listen(port, () => {
    const v = view(0);
    log.info('listening', {
      url: `http://localhost:${port}`,
      file: filePath,
      channelCount: v.hdr.channelCount,
      sampleRateHz: v.hdr.sampleRateExactHz,
      totalFrames: v.extent.totalFrames,
      finalised: v.hdr.finalised,
      mode: 'READ-ONLY — this process cannot affect the recorder',
    });
    process.stderr.write(`\n  biosignal viewer:  http://localhost:${port}\n\n`);
  });

  process.on('SIGINT', () => {
    server.close();
    cached?.close();
    process.exit(0);
  });
}

main();
