// HTTP routes. Small on purpose: every route delegates to one module.

import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '../util/logger.ts';
import { NoRecordingError, type RecordingView } from './recording-view.ts';
import type { Transport, TransportCommand } from './transport.ts';
import type { Session } from './session.ts';
import { createFrameRenderer } from './frames.ts';
import { runValidator } from './processes.ts';

const DIST = path.join(import.meta.dirname, '..', '..', 'ui', 'dist');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

interface Deps {
  view: RecordingView;
  transport: Transport;
  session: Session;
  defaults: { channelCount: number; sampleRateHz: number };
  log: Logger;
}

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const readBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (e) {
        reject(e);
      }
    });
  });

export function createRouter({ view, transport, session, defaults, log }: Deps) {
  const frames = createFrameRenderer();

  function frame(url: URL, res: ServerResponse): void {
    const v = view.open();
    const q = url.searchParams;
    const channels = (q.get('channels') ?? '').split(',').filter(Boolean).map(Number).filter((c) => Number.isInteger(c) && c >= 0 && c < v.hdr.channelCount);
    const span = Math.max(1, Math.round(Number(q.get('seconds') ?? 10) * v.hdr.sampleRateExactHz));
    // Live follows the newest committed data; otherwise the window is centred on the cursor.
    const from = transport.mode === 'live' ? v.extent.endFrame - span : Math.min(transport.position(v) - Math.floor(span / 2), v.extent.endFrame - span);
    const body = frames.render(v, { fromFrame: Math.max(0, from), spanFrames: span, channels, columns: Number(q.get('columns') ?? 1000) }, { transport: transport.snapshot(v), recorder: view.health() });
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  }

  function serveStatic(url: URL, res: ServerResponse): void {
    const file = path.join(DIST, path.normalize(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(DIST) || !fs.existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found. Run "npm run ui:build" first.\n');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = `${req.method} ${url.pathname}`;
    try {
      switch (route) {
        case 'GET /api/meta':
          return json(res, 200, view.meta(defaults));
        case 'GET /api/session':
          return json(res, 200, session.state);
        case 'POST /api/session/start':
          await session.start();
          return json(res, 200, session.state);
        case 'POST /api/session/stop':
          void session.stop(); // returns while stopping; the client polls /api/session
          return json(res, 200, session.state);
        case 'GET /api/frame':
          return frame(url, res);
        case 'POST /api/transport':
          return json(res, 200, transport.apply((await readBody(req)) as TransportCommand, view.open()));
        case 'POST /api/validate':
          return json(res, 200, await runValidator(view.open().filePath));
        default:
          return serveStatic(url, res);
      }
    } catch (e) {
      if (e instanceof NoRecordingError) {
        res.writeHead(204);
        return void res.end();
      }
      log.error('request-failed', { route, message: (e as Error).message });
      return json(res, 500, { error: (e as Error).message });
    }
  };
}
