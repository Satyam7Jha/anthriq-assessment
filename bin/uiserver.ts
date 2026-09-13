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
  --port N               HTTP port (default $PORT, else ${D.UI_PORT}; the default falls back to the next free port)
  --max-recording-seconds N   stop browser-started recordings after N seconds (default $SIGACQ_MAX_RECORDING_SECONDS, else none)
  --keep-recordings N         delete all but the newest N recordings (default $SIGACQ_KEEP_RECORDINGS, else keep all)
`;

const { opts, positional } = parseArgv(process.argv.slice(2), { booleans: ['help'] });
if (opts.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
const file = opts.follow ?? positional[0];
const cfg = resolveConfig({ channelCount: opts.channels, sampleRateHz: opts.rate });

const env = process.env;
startServer({
  file: file ? path.resolve(String(file)) : null,
  port: Number(opts.port ?? env.PORT ?? D.UI_PORT),
  explicitPort: opts.port !== undefined || env.PORT !== undefined,
  recordingsDir: path.resolve(String(opts.recordings ?? 'recordings')),
  maxRecordingSeconds: Number(opts.maxRecordingSeconds ?? env.SIGACQ_MAX_RECORDING_SECONDS ?? 0),
  keepRecordings: Number(opts.keepRecordings ?? env.SIGACQ_KEEP_RECORDINGS ?? 0),
  channelCount: cfg.channelCount,
  sampleRateHz: cfg.sampleRateHz,
});
