#!/usr/bin/env node
// PROCESS A — the generator. Logic: src/generator/.

import { parseArgv } from '../src/util/cli.ts';
import { resolveConfig, describeConfig, ConfigError } from '../src/config/config.ts';
import { DEFAULTS as D } from '../src/config/defaults.ts';
import { createLogger } from '../src/util/logger.ts';
import { runGenerator } from '../src/generator/generator.ts';

const USAGE = `
generator — emits the deterministic signal at the configured real-world rate

  node bin/generator.ts [options]

  --socket PATH         AF_UNIX socket to connect to  (default /tmp/sigacq.sock)
  --sink null           generate and discard; measures pacing with no consumer
  --channels N          channel count                 (default ${D.CHANNEL_COUNT})
  --rate HZ             samples per second per channel (default ${D.SAMPLE_RATE_HZ})
  --duration S          stop after S seconds          (default: until interrupted)
  --no-dither           disable the dither term
  --gen-ring-blocks N   generator ring depth          (default ${D.GENERATOR_RING_BLOCKS})
  --stats-interval S    stats line period, 0 = off    (default ${D.STATS_INTERVAL_SECONDS})
  --pacing-out PATH     write the pacing report as JSON on exit
  --quiet
`;

const { opts } = parseArgv(process.argv.slice(2), { booleans: ['dither', 'quiet', 'help'], aliases: { c: 'channels', r: 'rate', d: 'duration' } });
if (opts.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

try {
  const cfg = resolveConfig({
    channelCount: opts.channels,
    sampleRateHz: opts.rate,
    dither: opts.dither,
    duration: opts.duration,
    generatorRingBlocks: opts.genRingBlocks,
    statsIntervalSeconds: opts.statsInterval,
    socketPath: opts.socket,
    config: opts.config,
  });
  if (!opts.quiet) process.stderr.write(`${describeConfig(cfg)}\n`);
  runGenerator({
    cfg,
    socketPath: opts.sink === 'null' ? null : (cfg.socketPath ?? '/tmp/sigacq.sock'),
    pacingOut: opts.pacingOut ? String(opts.pacingOut) : undefined,
    log: createLogger({ component: 'generator', quiet: !!opts.quiet }),
  });
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  process.stderr.write(`configuration error: ${e.message}\n`);
  process.exit(64);
}
