// PROCESS E — the viewer server: read-only access to recordings, plus starting and stopping them as
// separate processes. Listening, port fallback and clean exit live here; everything else is delegated.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLogger } from '../util/logger.ts';
import { createRecordingView } from './recording-view.ts';
import { createTransport } from './transport.ts';
import { createSession } from './session.ts';
import { createRouter } from './routes.ts';

export interface ServerOptions {
  file: string | null;
  port: number;
  /** An explicit --port is used exactly; the default falls back to the next free port. */
  explicitPort: boolean;
  recordingsDir: string;
  /** Stop a browser-started recording after this long; 0 means never. Bounds a public demo's disk. */
  maxRecordingSeconds: number;
  /** Keep only the newest N recordings; 0 keeps all. */
  keepRecordings: number;
  channelCount: number;
  sampleRateHz: number;
}

export function startServer(o: ServerOptions): void {
  const log = createLogger({ component: 'uiserver' });
  const view = createRecordingView(o.file);
  const transport = createTransport();
  const defaults = { channelCount: o.channelCount, sampleRateHz: o.sampleRateHz };
  const session = createSession({ view, transport, recordingsDir: o.recordingsDir, maxRecordingSeconds: o.maxRecordingSeconds, keepRecordings: o.keepRecordings, ...defaults, log });
  const handle = createRouter({ view, transport, session, defaults, limits: { maxRecordingSeconds: o.maxRecordingSeconds }, log });
  const server = http.createServer((req, res) => void handle(req, res));

  let attempt = 0;
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EADDRINUSE') throw err;
    if (!o.explicitPort && attempt < 10) return void server.listen(o.port + ++attempt);
    process.stderr.write(`\n  Port ${o.port + attempt} is already in use. Stop the other viewer, or choose one with --port.\n\n`);
    process.exit(1);
  });
  server.on('listening', () => {
    const { port } = server.address() as AddressInfo;
    if (port !== o.port) process.stderr.write(`\n  port ${o.port} was busy, using ${port}`);
    process.stderr.write(`\n  sigacq:  http://localhost:${port}\n\n`);
    log.info('listening', { port, file: view.path, recordingsDir: o.recordingsDir });
  });
  server.listen(o.port);

  // Never leave acquisition processes orphaned.
  let quitting = false;
  const quit = async () => {
    if (quitting) process.exit(130);
    quitting = true;
    await session.shutdown();
    view.invalidate();
    process.exit(0);
  };
  process.on('SIGINT', () => void quit());
  process.on('SIGTERM', () => void quit());
}
