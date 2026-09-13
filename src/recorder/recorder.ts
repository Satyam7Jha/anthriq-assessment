// PROCESS B — the recorder (PLAN §7).
//
// It owns the file, so it owns the socket: it is the server and the generator connects. Every buffer
// is allocated before the first byte is accepted, so RSS has no term that grows with run duration.

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Config } from '../config/config.ts';
import { DEFAULTS as D } from '../config/defaults.ts';
import { ByteRing } from '../ring/byte-ring.ts';
import { WireParser } from '../format/wire-parser.ts';
import { BlockWriter } from '../store/writer.ts';
import { createIngest } from '../acquire/ingest.ts';
import { DropLedger, CAUSE } from '../acquire/drop-ledger.ts';
import * as fileHeader from '../format/file-header.ts';
import type { FileHeaderInput } from '../format/file-header.ts';
import type { Logger } from '../util/logger.ts';
import { snapshot } from './telemetry.ts';
import { finalise } from './finalise.ts';

export interface RecorderOptions {
  cfg: Config;
  outPath: string;
  socketPath: string;
  statsOut?: string;
  injectStallMs?: number;
  log: Logger;
}

export function runRecorder({ cfg, outPath, socketPath, statsOut, injectStallMs = 0, log }: RecorderOptions): void {
  const ring = new ByteRing(cfg.ringBytes);
  const ledger = new DropLedger();
  const stage = Buffer.allocUnsafeSlow(cfg.blockPayloadBytes);
  const startMonoNanos = process.hrtime.bigint();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const fd = fs.openSync(outPath, 'w');

  const header: FileHeaderInput = {
    recordingId: crypto.randomBytes(16),
    channelCount: cfg.channelCount,
    sampleRateHz: cfg.sampleRateHz,
    framesPerBlock: cfg.framesPerBlock,
    blockStrideBytes: cfg.blockStrideBytes,
    startTimestampUnixNanos: BigInt(Date.now()) * 1_000_000n,
    startMonotonicNanos: startMonoNanos,
    ringBytes: cfg.ringBytes,
    fsyncIntervalSeconds: cfg.fsyncIntervalSeconds,
    generatorTickNanos: cfg.tickNanos,
    signalId: D.SIGNAL_ID,
    producer: `sigacq 1.0.0 node-${process.version} ${process.platform}-${process.arch}`,
    description: cfg.description,
    flags: cfg.dither ? 0 : fileHeader.FLAG.DITHER_DISABLED,
  };
  // Written at t=0 with FINALISED clear; rewritten at shutdown. Until then readers reconstruct totals
  // from the file length — which is what makes a SIGKILLed recording readable.
  fs.writeSync(fd, fileHeader.encode(header), 0, D.FILE_HEADER_BYTES, 0);

  let stopping = false;
  let diskError: NodeJS.ErrnoException | null = null;
  const writer = new BlockWriter({
    fd,
    geometry: cfg,
    injectStallMs,
    onWritten: () => !stopping && ingest.drain(), // backlog stays in the ring, where it is measured
    onError: (err) => {
      log.error('write-failed', { code: err.code, message: err.message });
      diskError = err;
      void finish();
    },
  });
  const ingest = createIngest({ ...cfg, ring, writer, ledger, stage, log });

  const parser = new WireParser(Math.max(cfg.wirePayloadBytes * 8, 1 << 20), {
    onBlock: (hdr, buf, payloadOffset) => {
      if (stopping || diskError || !ingest.onBlock(hdr, buf, payloadOffset)) return;
      const level = ring.updateLevel();
      if (level) log.throttled(level === 'HIGH' ? 'warn' : 'info', `ring-${level.toLowerCase()}`, { fillPct: +(ring.fillFraction * 100).toFixed(1) });
    },
    onGap: (startFrameIndex, frameCount) => {
      ledger.record(startFrameIndex, frameCount, CAUSE.TRANSPORT_GAP);
      log.warn('gap', { startFrameIndex, frameCount });
    },
    onDuplicate: (startFrameIndex, frameCount) => log.warn('duplicate', { startFrameIndex, frameCount }),
    onCorrupt: (bytesSkipped, reason) => log.throttled('warn', 'corrupt-bytes', { bytesSkipped, reason }),
  });

  fs.rmSync(socketPath, { force: true });
  const server = net.createServer((socket) => {
    log.info('generator-connected');
    socket.on('data', (chunk) => parser.push(chunk));
    socket.on('error', (err: NodeJS.ErrnoException) => log.warn('socket-error', { code: err.code }));
    // A generator going away does not end the recording; a reconnect's gap is reported by position.
  });
  server.listen(socketPath, () => log.info('listening', { socketPath, pid: process.pid }));

  const telemetry = () => snapshot({ startMonoNanos, parser, writer, ring, ledger, cfg });
  const statsStream = statsOut ? fs.createWriteStream(statsOut, { flags: 'a' }) : null;
  let lastFsync = Date.now();
  const timers = [
    setInterval(async () => {
      // fsync is deferred while the ring is filling: sync must never be the cause of an overflow.
      if (cfg.fsyncIntervalSeconds <= 0 || stopping || diskError || ring.fillFraction >= 0.25) return;
      if (Date.now() - lastFsync < cfg.fsyncIntervalSeconds * 1000) return;
      lastFsync = Date.now();
      await writer.fsync();
    }, 1000),
  ];
  if (cfg.statsIntervalSeconds > 0) {
    timers.push(
      setInterval(() => {
        const s = telemetry();
        log.info('stats', s);
        statsStream?.write(`${JSON.stringify(s)}\n`); // the viewer tails this read-only
      }, cfg.statsIntervalSeconds * 1000)
    );
  }
  timers.forEach((t) => t.unref());

  let finishing = false;
  async function finish(): Promise<void> {
    if (finishing) process.exit(130); // second signal
    finishing = stopping = true;
    server.close();
    timers.forEach(clearInterval);
    try {
      await finalise({ cfg, fd, outPath, header, writer, ingest, ledger, parser, telemetry, diskError: () => diskError, log });
      fs.rmSync(socketPath, { force: true });
      statsStream?.end();
      process.exit(diskError ? 1 : 0);
    } catch (e) {
      process.stderr.write(`shutdown failed: ${(e as Error).stack}\n`);
      process.exit(1);
    }
  }

  process.on('SIGINT', () => void finish());
  process.on('SIGTERM', () => void finish());
  log.info('start', { pid: process.pid, out: outPath, socketPath, ringSeconds: +cfg.ringSeconds.toFixed(2), blockStrideBytes: cfg.blockStrideBytes });
  if (cfg.duration > 0) setTimeout(() => void finish(), cfg.duration * 1000);
}
