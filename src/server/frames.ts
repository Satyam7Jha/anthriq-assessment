// One decimated window, as the binary frame the browser draws.
//
// Decimation happens here, not in the browser: 2 floats per pixel column per channel instead of
// 4,000 per channel-second. Buffers are reused across requests.
//
// Frame layout:  [u32 jsonBytes][JSON, space-padded to a 4-byte boundary][float32 envelopes]
// Envelopes are channels x columns x [min, max]; NaN marks a column with no data. The browser takes a
// Float32Array view over the response — no base64, no per-byte decode.

import { envelope } from '../viz/decimate.ts';
import type { OpenView } from './recording-view.ts';

export interface FrameRequest {
  /** A multiple of samplesPerColumn, so columns sit on an absolute grid. */
  fromFrame: number;
  spanFrames: number;
  channels: number[];
  columns: number;
  samplesPerColumn: number;
}

export function createFrameRenderer() {
  let scratch = new Float32Array(0);
  let envOut = new Float32Array(0);

  function render(v: OpenView, req: FrameRequest, extra: Record<string, unknown>): Buffer {
    const { hdr, extent, reader } = v;
    const from = Math.max(0, Math.min(req.fromFrame, extent.endFrame));
    const to = Math.min(from + req.spanFrames, extent.endFrame);
    const frames = to - from;
    const cols = Math.max(1, Math.min(req.columns, 4096));
    const C = req.channels.length;
    if (scratch.length < frames * C) scratch = new Float32Array(frames * C);
    if (envOut.length < C * cols * 2) envOut = new Float32Array(C * cols * 2);
    envOut.fill(NaN, 0, C * cols * 2);
    // NaN, not zero: this buffer is reused, and a region the reader does not fill is lost data.
    scratch.fill(NaN, 0, frames * C);

    const filled = new Int32Array(C);
    const slot = new Map(req.channels.map((c, k) => [c, k]));
    const bytesBefore = reader.stats.bytesRead;
    if (frames > 0) {
      for (const chunk of reader.readRange({ fromFrame: from, toFrame: to, channels: req.channels })) {
        const k = slot.get(chunk.channel)!;
        const at = chunk.startFrameIndex - from;
        scratch.set(chunk.data, k * frames + at);
        filled[k] = Math.max(filled[k], at + chunk.frameCount);
      }
    }
    const spc = Math.max(1, Math.floor(req.samplesPerColumn));
    for (let k = 0; k < C; k++) {
      if (filled[k] === 0) continue;
      // Whole columns of samplesPerColumn from the (grid-aligned) start: a partly filled window uses
      // only the columns it has data for, and never re-bins them.
      const used = Math.max(1, Math.min(cols, Math.ceil(filled[k] / spc)));
      envelope(scratch.subarray(k * frames, k * frames + filled[k]), used, envOut.subarray(k * cols * 2, (k * cols + used) * 2), spc);
    }

    const info = {
      ...extra,
      from,
      frames,
      columns: cols,
      samplesPerColumn: Math.max(1, Math.floor(req.samplesPerColumn)),
      channels: req.channels,
      sampleRateHz: hdr.sampleRateExactHz,
      totalFrames: extent.totalFrames,
      endFrame: extent.endFrame,
      finalised: hdr.finalised,
      bytesRead: reader.stats.bytesRead - bytesBefore,
      predictedBytes: frames ? reader.predictBytes({ fromFrame: from, toFrame: to, channelCount: C }) : 0,
      allChannelBytes: frames ? reader.predictBytes({ fromFrame: from, toFrame: to, channelCount: hdr.channelCount }) : 0,
    };
    let json = Buffer.from(JSON.stringify(info));
    const pad = (4 - ((4 + json.length) % 4)) % 4;
    if (pad) json = Buffer.concat([json, Buffer.alloc(pad, 0x20)]);
    const head = Buffer.allocUnsafe(4);
    head.writeUInt32LE(json.length, 0);
    return Buffer.concat([head, json, Buffer.from(envOut.buffer, 0, C * cols * 2 * 4)]);
  }

  return { render };
}
