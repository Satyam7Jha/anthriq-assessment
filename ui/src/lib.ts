import type { Envelopes, WindowPayload } from './types';

/** Decode the base64 envelopes into Float32Arrays, reusing the caller's buffers where the shape is
 *  unchanged. Reuse matters: at 20 Hz with 32 channels, allocating fresh arrays would create
 *  ~2.5 MB/s of garbage for the browser's GC to chase during rendering. */
export function decodeEnvelopes(payload: WindowPayload, into: Envelopes): Envelopes {
  for (const [key, b64] of Object.entries(payload.channels)) {
    const channel = Number(key);
    const binary = atob(b64);
    const floats = binary.length / 4;
    let target = into.get(channel);
    if (!target || target.length !== floats) {
      target = new Float32Array(floats);
      into.set(channel, target);
    }
    const bytes = new Uint8Array(target.buffer);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  }
  for (const key of into.keys()) if (!(String(key) in payload.channels)) into.delete(key);
  return into;
}

export const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-US');

export function fmtBytes(b: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(2)} ${units[i]}`;
}

export function fmtClock(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec.toFixed(3).padStart(6, '0')}`;
}

/** Default channel labels. A --montage file can map these onto 10–20 electrode positions; the names
 *  are metadata only and never touch the signal. */
export const TEN_TWENTY_32 = [
  'Fp1', 'Fp2', 'F7', 'F3', 'Fz', 'F4', 'F8', 'FC5',
  'FC1', 'FC2', 'FC6', 'T7', 'C3', 'Cz', 'C4', 'T8',
  'CP5', 'CP1', 'CP2', 'CP6', 'P7', 'P3', 'Pz', 'P4',
  'P8', 'PO9', 'O1', 'Oz', 'O2', 'PO10', 'AF7', 'AF8',
];

export function channelLabel(index: number, useMontage: boolean, channelCount: number): string {
  if (useMontage && channelCount <= TEN_TWENTY_32.length) {
    return TEN_TWENTY_32[index] ?? `ch${String(index).padStart(2, '0')}`;
  }
  return `ch${String(index).padStart(2, '0')}`;
}
