// The server's read-only window onto the current recording (PLAN §11.3).
//
// This process never joins the acquisition socket and never writes the file: it opens it O_RDONLY
// and reads with pread. It has no channel through which to slow the recorder down. The view is
// re-opened when stale, because a live file's committed extent keeps growing — which also means the
// crash-recovery path runs continuously.

import fs from 'node:fs';
import path from 'node:path';
import { openRecording, readLedger } from '../store/recover.ts';
import type { Recording } from '../store/recover.ts';
import { makeReader } from '../store/reader.ts';
import type { Reader } from '../store/reader.ts';

export interface OpenView extends Recording {
  reader: Reader;
}

export class NoRecordingError extends Error {}

const statsPathFor = (file: string) => file.replace(/\.sigb$/, '') + '.stats.ndjson';

export function createRecordingView(initialPath: string | null) {
  let filePath = initialPath;
  let cached: OpenView | null = null;
  let openedAt = 0;

  function invalidate(): void {
    cached?.close();
    cached = null;
  }

  function open(maxAgeMs = 200): OpenView {
    if (!filePath || !fs.existsSync(filePath)) throw new NoRecordingError('no recording');
    if (cached && cached.filePath === filePath && Date.now() - openedAt < maxAgeMs) return cached;
    invalidate();
    const rec = openRecording(filePath);
    cached = { ...rec, reader: makeReader(rec) };
    openedAt = Date.now();
    return cached;
  }

  /** What the browser needs to describe the recording. */
  function meta(defaults: { channelCount: number; sampleRateHz: number }) {
    if (!filePath || !fs.existsSync(filePath)) return { empty: true as const, ...defaults };
    const v = open(0);
    const { hdr, extent } = v;
    return {
      file: path.basename(filePath),
      fileSizeBytes: v.fileSize,
      channelCount: hdr.channelCount,
      sampleRateHz: hdr.sampleRateExactHz,
      dtype: hdr.dtypeName,
      totalFrames: extent.totalFrames,
      totalValues: extent.totalValues,
      endFrame: extent.endFrame,
      durationSeconds: extent.endFrame / hdr.sampleRateExactHz,
      finalised: hdr.finalised,
      signalId: hdr.signalId,
      droppedValues: hdr.droppedFramesTotal * hdr.channelCount,
      // Loss markers in the EDF+ annotation shape: onset and duration in seconds.
      markers: readLedger(v).entries.map((e) => ({
        onsetSeconds: e.startFrameIndex / hdr.sampleRateExactHz,
        durationSeconds: e.frameCount / hdr.sampleRateExactHz,
        cause: e.cause,
      })),
    };
  }

  /** The recorder's latest telemetry line, tailed read-only — no IPC, so no backpressure path either. */
  function health(): Record<string, unknown> | null {
    if (!filePath) return null;
    const stats = statsPathFor(filePath);
    if (!fs.existsSync(stats)) return null;
    const size = fs.statSync(stats).size;
    const want = Math.min(size, 8192);
    const fd = fs.openSync(stats, 'r');
    try {
      const buf = Buffer.allocUnsafe(want);
      fs.readSync(fd, buf, 0, want, size - want);
      const lines = buf.toString('utf8').trim().split('\n').reverse();
      for (const line of lines) {
        try {
          return JSON.parse(line);
        } catch {
          // a partially written trailing line; try the previous one
        }
      }
      return null;
    } finally {
      fs.closeSync(fd);
    }
  }

  return {
    get path() {
      return filePath;
    },
    setPath(p: string): void {
      filePath = p;
      invalidate();
    },
    statsPathFor,
    open,
    invalidate,
    meta,
    health,
  };
}

export type RecordingView = ReturnType<typeof createRecordingView>;
