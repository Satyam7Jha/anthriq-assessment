import type { Envelopes, FrameInfo } from './types';

const decoder = new TextDecoder();

/**
 * Split a binary frame into its JSON header and a zero-copy Float32Array over the envelopes.
 * Layout: [u32 jsonBytes][json padded to 4 bytes][float32 ...]. No base64, no per-byte loop — the
 * view costs nothing, which is why this runs on the main thread without a Worker.
 */
export function decodeFrame(buf: ArrayBuffer): { info: FrameInfo; envelopes: Envelopes } {
  const jsonBytes = new DataView(buf).getUint32(0, true);
  const info = JSON.parse(decoder.decode(new Uint8Array(buf, 4, jsonBytes))) as FrameInfo;
  const data = new Float32Array(buf, 4 + jsonBytes, info.channels.length * info.columns * 2);
  return { info, envelopes: { channels: info.channels, columns: info.columns, data } };
}

export const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-US');

export function fmtBytes(b: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** 1:04:12 or 4:12 — the way a media player shows time. */
export function fmtTime(seconds: number, withFraction = false): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const frac = withFraction ? `.${String(Math.floor((s % 1) * 10))}` : '';
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}${frac}`;
}
