'use strict';
// Layered configuration. PLAN R4/R5: channel count and sample rate must be RUNTIME-CONFIGURABLE and
// not hard-coded, and the mechanism must be documented.
//
// Resolution order, highest priority first:
//   1. CLI flags            --channels 8 --rate 1000
//   2. Environment          SIGACQ_CHANNELS=8 SIGACQ_RATE=1000
//   3. JSON config file     --config path.json  (or ./sigacq.config.json if present)
//   4. Built-in defaults    src/config/defaults.js
//
// Every resolved value carries its SOURCE, and `sigctl info` / the recorder's startup banner print
// it. "Where did this 4000 come from" should never require reading the code.

const fs = require('node:fs');
const path = require('node:path');
const D = require('./defaults');

const ENV_PREFIX = 'SIGACQ_';

// Each entry: [configKey, envSuffix, defaultValue, parse, validate]
const SPEC = [
  ['channelCount', 'CHANNELS', D.CHANNEL_COUNT, Number, (v) => Number.isInteger(v) && v >= 1 && v <= 4096],
  ['sampleRateHz', 'RATE', D.SAMPLE_RATE_HZ, Number, (v) => Number.isFinite(v) && v > 0 && v <= 1e6],
  ['dither', 'DITHER', D.DITHER, toBool, (v) => typeof v === 'boolean'],
  ['tickNanos', 'TICK_NANOS', Number(D.TICK_NANOS), Number, (v) => v >= 100_000 && v <= 100_000_000],
  ['framesPerBlock', 'FRAMES_PER_BLOCK', D.FRAMES_PER_FILE_BLOCK, Number, (v) => Number.isInteger(v) && v >= 1],
  ['ringBytes', 'RING_BYTES', D.RECORDER_RING_BYTES, Number, (v) => Number.isInteger(v) && v >= D.MIN_RING_BYTES],
  ['generatorRingBlocks', 'GEN_RING_BLOCKS', D.GENERATOR_RING_BLOCKS, Number, (v) => Number.isInteger(v) && v >= 2],
  ['fsyncIntervalSeconds', 'FSYNC_INTERVAL', D.FSYNC_INTERVAL_SECONDS, Number, (v) => v >= 0],
  ['statsIntervalSeconds', 'STATS_INTERVAL', D.STATS_INTERVAL_SECONDS, Number, (v) => v >= 0],
  ['socketPath', 'SOCKET', null, String, () => true],
  ['duration', 'DURATION', 0, Number, (v) => v >= 0], // 0 = run until interrupted
  ['description', 'DESCRIPTION', '', String, () => true],
];

function toBool(v) {
  if (typeof v === 'boolean') return v;
  return !(v === 'false' || v === '0' || v === 0);
}

class ConfigError extends Error {}

function resolveConfig(opts = {}, env = process.env) {
  // --- layer 3: JSON file ---
  let fileCfg = {};
  let fileUsed = null;
  const explicit = opts.config;
  const implicit = path.join(process.cwd(), 'sigacq.config.json');
  const candidate = explicit ?? (fs.existsSync(implicit) ? implicit : null);
  if (candidate) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      fileUsed = candidate;
    } catch (e) {
      throw new ConfigError(`cannot read config file ${candidate}: ${e.message}`);
    }
  }

  const cfg = {};
  const sources = {};
  for (const [key, envSuffix, dflt, parse, ok] of SPEC) {
    let value;
    let source;
    if (opts[key] !== undefined) {
      value = parse(opts[key]);
      source = 'cli';
    } else if (env[ENV_PREFIX + envSuffix] !== undefined) {
      value = parse(env[ENV_PREFIX + envSuffix]);
      source = `env:${ENV_PREFIX}${envSuffix}`;
    } else if (fileCfg[key] !== undefined) {
      value = parse(fileCfg[key]);
      source = `file:${path.basename(fileUsed)}`;
    } else {
      value = dflt;
      source = 'default';
    }
    if (value !== null && !ok(value)) {
      throw new ConfigError(`invalid ${key}=${JSON.stringify(value)} (from ${source})`);
    }
    cfg[key] = value;
    sources[key] = source;
  }

  // --- derived, computed in exactly one place so every process agrees ---
  cfg.bytesPerValue = D.BYTES_PER_VALUE;
  cfg.dtypeCode = D.DTYPE_CODE;
  cfg.bytesPerFrame = cfg.channelCount * cfg.bytesPerValue;
  cfg.framesPerTick = Math.max(1, Math.round((cfg.sampleRateHz * cfg.tickNanos) / 1e9));
  cfg.wirePayloadBytes = cfg.framesPerTick * cfg.bytesPerFrame;
  cfg.wireBlockBytes = D.WIRE_HEADER_BYTES + cfg.wirePayloadBytes;
  cfg.blockPayloadBytes = cfg.framesPerBlock * cfg.bytesPerFrame;
  cfg.blockStrideBytes = D.BLOCK_HEADER_BYTES + cfg.blockPayloadBytes;
  cfg.valuesPerSecond = cfg.channelCount * cfg.sampleRateHz;
  cfg.bytesPerSecond = cfg.valuesPerSecond * cfg.bytesPerValue;
  cfg.ringSeconds = cfg.ringBytes / cfg.bytesPerSecond;
  cfg.generatorRingSeconds = (cfg.generatorRingBlocks * cfg.framesPerTick) / cfg.sampleRateHz;
  cfg.sources = sources;
  cfg.configFile = fileUsed;
  return cfg;
}

/** Human-readable provenance block for `sigctl info` and the recorder banner. */
function describeConfig(cfg) {
  const rows = SPEC.map(([k]) => `  ${k.padEnd(22)} ${String(cfg[k]).padEnd(24)} [${cfg.sources[k]}]`);
  return [
    `configuration (resolution order: CLI > env ${ENV_PREFIX}* > JSON file > defaults)`,
    ...rows,
    `  ${'derived'.padEnd(22)} ${cfg.valuesPerSecond.toLocaleString('en-US')} values/s, ` +
      `${cfg.bytesPerSecond.toLocaleString('en-US')} B/s, block stride ${cfg.blockStrideBytes} B`,
  ].join('\n');
}

module.exports = { resolveConfig, describeConfig, ConfigError, SPEC, ENV_PREFIX };
