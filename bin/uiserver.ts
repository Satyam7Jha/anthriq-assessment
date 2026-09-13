#!/usr/bin/env node
// PROCESS E — the viewer. Logic: src/server/.

import path from 'node:path';
import { parseArgv } from '../src/util/cli.ts';
import { resolveConfig } from '../src/config/config.ts';
import { DEFAULTS as D } from '../src/config/defaults.ts';
import { startServer } from '../src/server/server.ts';

const USAGE = `
uiserver — the viewer: record from the browser, or open an existing recording

  node bin/uiserver.ts                      start empty, ready to record
  node bin/uiserver.ts --follow FILE.sigb   open an existing or live recording

  --recordings DIR       where browser-started recordings go  (default ./recordings)
  --channels N / --rate  settings for new recordings
  --port N               HTTP port (default ${D.UI_PORT}; falls back to the next free port)
`;

const { opts, positional } = parseArgv(process.argv.slice(2), { booleans: ['help'] });
if (opts.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
const file = opts.follow ?? positional[0];
const cfg = resolveConfig({ channelCount: opts.channels, sampleRateHz: opts.rate });

startServer({
  file: file ? path.resolve(String(file)) : null,
  port: Number(opts.port ?? D.UI_PORT),
  explicitPort: opts.port !== undefined,
  recordingsDir: path.resolve(String(opts.recordings ?? 'recordings')),
  channelCount: cfg.channelCount,
  sampleRateHz: cfg.sampleRateHz,
});
