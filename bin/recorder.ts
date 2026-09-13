#!/usr/bin/env node
// PROCESS B — the recorder. Logic: src/recorder/.

import path from 'node:path';
import { parseArgv } from '../src/util/cli.ts';
import { resolveConfig, describeConfig, ConfigError } from '../src/config/config.ts';
import { DEFAULTS as D } from '../src/config/defaults.ts';
import { createLogger } from '../src/util/logger.ts';
import { runRecorder } from '../src/recorder/recorder.ts';

const USAGE = `
recorder — persists the stream to a .sigb file with bounded memory and positioned loss accounting

  node bin/recorder.ts --out FILE [options]

  --out PATH                  output .sigb path (required)
  --socket PATH               AF_UNIX socket to listen on   (default /tmp/sigacq.sock)
  --channels N / --rate HZ    expected channel count and sample rate
  --duration S                stop after S seconds          (default: until interrupted)
  --ring-bytes N              bounded ring size             (default ${D.RECORDER_RING_BYTES})
  --frames-per-block N        file block size in frames     (default ${D.FRAMES_PER_FILE_BLOCK})
  --fsync-interval S          fsync period, 0 = never       (default ${D.FSYNC_INTERVAL_SECONDS})
  --stats-interval S          stats line period             (default ${D.STATS_INTERVAL_SECONDS})
  --stats-out PATH            append stats as NDJSON (the viewer tails this)
  --inject-write-stall-ms N   fault injection: delay every disk write by N ms
  --no-dither                 record that the source had dither disabled
  --description TEXT
  --quiet
`;

const { opts } = parseArgv(process.argv.slice(2), { booleans: ['dither', 'quiet', 'help'], aliases: { o: 'out', c: 'channels', r: 'rate', d: 'duration' } });
if (opts.help || !opts.out) {
  process.stdout.write(USAGE);
  process.exit(opts.help ? 0 : 64);
}

try {
  const cfg = resolveConfig({
    channelCount: opts.channels,
    sampleRateHz: opts.rate,
    dither: opts.dither,
    duration: opts.duration,
    ringBytes: opts.ringBytes,
    framesPerBlock: opts.framesPerBlock,
    fsyncIntervalSeconds: opts.fsyncInterval,
    statsIntervalSeconds: opts.statsInterval,
    socketPath: opts.socket,
    description: opts.description,
    config: opts.config,
  });
  if (!opts.quiet) process.stderr.write(`${describeConfig(cfg)}\n`);
  runRecorder({
    cfg,
    outPath: path.resolve(String(opts.out)),
    socketPath: cfg.socketPath ?? '/tmp/sigacq.sock',
    statsOut: opts.statsOut ? String(opts.statsOut) : undefined,
    injectStallMs: Number(opts.injectWriteStallMs ?? 0),
    log: createLogger({ component: 'recorder', quiet: !!opts.quiet }),
  });
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  process.stderr.write(`configuration error: ${e.message}\n`);
  process.exit(64);
}
