// Every call the viewer makes to the server, in one place.

import type { EmptyMeta, EnvelopeData, FrameInfo, Meta, Session, TransportCommand, TransportState, Validation } from '../types';

const decoder = new TextDecoder();

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as T;
}

const post = <T>(url: string, body?: unknown) =>
  json<T>(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  meta: () => json<Meta | EmptyMeta>('/api/meta'),
  session: () => json<Session>('/api/session'),
  startRecording: () => post<Session>('/api/session/start'),
  stopRecording: () => post<Session>('/api/session/stop'),
  transport: (cmd: TransportCommand) => post<TransportState>('/api/transport', cmd),
  validate: () => post<Validation>('/api/validate'),

  /** Plain links, so the browser handles the download: progress, cancel, and where to save it. */
  downloads: {
    recording: '/api/download/recording',
    metadata: '/api/download/metadata',
    csv: (q: { fromSeconds: number; seconds: number; channels: number[] }) =>
      `/api/download/csv?from=${q.fromSeconds.toFixed(3)}&seconds=${q.seconds.toFixed(3)}&channels=${q.channels.join(',')}`,
  },

  /**
   * One decimated window. Binary: [u32 jsonBytes][json padded to 4 bytes][float32 envelopes], read
   * through a zero-copy Float32Array view — nothing to decode byte by byte, so no Worker is needed.
   * Returns null while there is nothing to show (204).
   */
  async frame(q: { channels: number[]; columns: number; seconds: number }): Promise<{ info: FrameInfo; envelopes: EnvelopeData } | null> {
    const res = await fetch(`/api/frame?channels=${q.channels.join(',')}&columns=${q.columns}&seconds=${q.seconds}`);
    if (res.status !== 200) return null;
    const buf = await res.arrayBuffer();
    const jsonBytes = new DataView(buf).getUint32(0, true);
    const info = JSON.parse(decoder.decode(new Uint8Array(buf, 4, jsonBytes))) as FrameInfo;
    const data = new Float32Array(buf, 4 + jsonBytes, info.channels.length * info.columns * 2);
    return { info, envelopes: { channels: info.channels, columns: info.columns, data } };
  },
};
