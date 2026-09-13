// Layered configuration (R4/R5): channel count and sample rate are runtime-configurable.
//
// Resolution order, highest first:
//   1. CLI flags         --channels 8 --rate 1000
//   2. Environment       SIGACQ_CHANNELS=8 SIGACQ_RATE=1000
//   3. JSON file         --config path.json  (or ./sigacq.config.json if present)
//   4. Built-in defaults src/config/defaults.ts
//
// Every value carries its source, and the processes print it, so "where did this 4000 come from"
// never requires reading code.

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS as D } from './defaults.ts';

export const ENV_PREFIX = 'SIGACQ_';

export interface BaseConfig {
  channelCount: number;
  sampleRateHz: number;
  dither: boolean;
  tickNanos: number;
  framesPerBlock: number;
  ringBytes: number;
  generatorRingBlocks: number;
  fsyncIntervalSeconds: number;
  statsIntervalSeconds: number;
  socketPath: string | null;
  duration: number;
  description: string;
}

export interface Config extends BaseConfig {
  bytesPerValue: number;
  dtypeCode: number;
  bytesPerFrame: number;
  framesPerTick: number;
  wirePayloadBytes: number;
  wireBlockBytes: number;
  blockPayloadBytes: number;
  blockStrideBytes: number;
  valuesPerSecond: number;
  bytesPerSecond: number;
  ringSeconds: number;
  generatorRingSeconds: number;
  sources: Record<keyof BaseConfig, string>;
  configFile: string | null;
}

type Key = keyof BaseConfig;
type Spec = [key: Key, env: string, fallback: unknown, parse: (v: unknown) => unknown, ok: (v: any) => boolean];

const toBool = (v: unknown): boolean => (typeof v === 'boolean' ? v : !(v === 'false' || v === '0' || v === 0));

export const SPEC: Spec[] = [
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
  ['duration', 'DURATION', 0, Number, (v) => v >= 0], // 0 = until interrupted
  ['description', 'DESCRIPTION', '', String, () => true],
];

export class ConfigError extends Error {}

export type ConfigInput = Partial<Record<Key, unknown>> & { config?: unknown };

export function resolveConfig(opts: ConfigInput = {}, env: NodeJS.ProcessEnv = process.env): Config {
  let fileCfg: Record<string, unknown> = {};
  let fileUsed: string | null = null;
  const implicit = path.join(process.cwd(), 'sigacq.config.json');
  const candidate = opts.config !== undefined ? String(opts.config) : fs.existsSync(implicit) ? implicit : null;
  if (candidate) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      fileUsed = candidate;
    } catch (e) {
      throw new ConfigError(`cannot read config file ${candidate}: ${(e as Error).message}`);
    }
  }

  const base = {} as Record<Key, unknown>;
  const sources = {} as Record<Key, string>;
  for (const [key, envSuffix, fallback, parse, ok] of SPEC) {
    let value: unknown;
    let source: string;
    if (opts[key] !== undefined) [value, source] = [parse(opts[key]), 'cli'];
    else if (env[ENV_PREFIX + envSuffix] !== undefined) [value, source] = [parse(env[ENV_PREFIX + envSuffix]), `env:${ENV_PREFIX}${envSuffix}`];
    else if (fileCfg[key] !== undefined) [value, source] = [parse(fileCfg[key]), `file:${path.basename(fileUsed!)}`];
    else [value, source] = [fallback, 'default'];
    if (value !== null && !ok(value)) throw new ConfigError(`invalid ${key}=${JSON.stringify(value)} (from ${source})`);
    base[key] = value;
    sources[key] = source;
  }
  return derive(base as unknown as BaseConfig, sources, fileUsed);
}

/** Derived values, computed in exactly one place so every process agrees. */
function derive(b: BaseConfig, sources: Record<Key, string>, configFile: string | null): Config {
  const bytesPerValue = D.BYTES_PER_VALUE;
  const bytesPerFrame = b.channelCount * bytesPerValue;
  const framesPerTick = Math.max(1, Math.round((b.sampleRateHz * b.tickNanos) / 1e9));
  const wirePayloadBytes = framesPerTick * bytesPerFrame;
  const blockPayloadBytes = b.framesPerBlock * bytesPerFrame;
  const valuesPerSecond = b.channelCount * b.sampleRateHz;
  const bytesPerSecond = valuesPerSecond * bytesPerValue;
  return {
    ...b,
    bytesPerValue,
    dtypeCode: D.DTYPE_CODE,
    bytesPerFrame,
    framesPerTick,
    wirePayloadBytes,
    wireBlockBytes: D.WIRE_HEADER_BYTES + wirePayloadBytes,
    blockPayloadBytes,
    blockStrideBytes: D.BLOCK_HEADER_BYTES + blockPayloadBytes,
    valuesPerSecond,
    bytesPerSecond,
    ringSeconds: b.ringBytes / bytesPerSecond,
    generatorRingSeconds: (b.generatorRingBlocks * framesPerTick) / b.sampleRateHz,
    sources,
    configFile,
  };
}

/** Provenance block for the startup banners. */
export function describeConfig(cfg: Config): string {
  const rows = SPEC.map(([k]) => `  ${k.padEnd(22)} ${String(cfg[k]).padEnd(24)} [${cfg.sources[k]}]`);
  return [
    `configuration (resolution order: CLI > env ${ENV_PREFIX}* > JSON file > defaults)`,
    ...rows,
    `  ${'derived'.padEnd(22)} ${cfg.valuesPerSecond.toLocaleString('en-US')} values/s, ` +
      `${cfg.bytesPerSecond.toLocaleString('en-US')} B/s, block stride ${cfg.blockStrideBytes} B`,
  ].join('\n');
}
