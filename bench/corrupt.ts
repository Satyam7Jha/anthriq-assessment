// Damage a good recording four ways; the validator must report the right class, count and first
// position for each. An always-PASS validator is indistinguishable from `exit 0`.
//
//   MISSING     a block spliced out — later blocks keep their absolute indices, like a real drop
//   DUPLICATED  a block written twice
//   INCORRECT   one value changed and the block CRC REPAIRED, so the damage cannot hide behind it
//   CORRUPT     one value changed with the CRC left stale — must not read as 128,000 incorrect values
//
// Run:  node bench/corrupt.ts FILE.sigb   (a finalised, drop-free recording)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as blockHeader from '../src/format/block-header.ts';
import { crc32c } from '../src/format/crc32c.ts';
import { validate, report } from './lib.ts';

const src = process.argv[2];
if (!src) throw new Error('usage: node bench/corrupt.ts FILE.sigb');
const original = fs.readFileSync(src);
const H = { headerBytes: original.readUInt16LE(10), channelCount: original.readUInt32LE(32), framesPerBlock: original.readUInt32LE(56), stride: Number(original.readBigUInt64LE(64)) };
const off = (b: number) => H.headerBytes + b * H.stride;
const perBlock = H.framesPerBlock * H.channelCount;
const tmp = (name: string) => path.join(os.tmpdir(), `sigacq-corrupt-${name}.sigb`);
const checks: [string, boolean][] = [];
const check = (name: string, actual: unknown, expected: unknown) => checks.push([`${name}: ${actual}${actual === expected ? '' : ` (expected ${expected})`}`, actual === expected]);

{
  const file = tmp('missing');
  fs.writeFileSync(file, Buffer.concat([original.subarray(0, off(2)), original.subarray(off(3))]));
  const r = validate(file);
  check('missing → exit', r.exitCode, 1);
  check('missing → count', r.missing, perBlock);
  check('missing → first value index', r.firstDiscrepancy.missing?.valueIndex, 2 * perBlock);
  check('missing → no incorrect', r.incorrect, 0);
}
{
  const file = tmp('duplicated');
  fs.writeFileSync(file, Buffer.concat([original.subarray(0, off(2)), original.subarray(off(1), off(2)), original.subarray(off(2))]));
  const r = validate(file);
  check('duplicated → exit', r.exitCode, 1);
  check('duplicated → count', r.duplicated, perBlock);
  check('duplicated → first value index', r.firstDiscrepancy.duplicated?.valueIndex, perBlock);
}
{
  const buf = Buffer.from(original);
  const base = off(3);
  const bh = blockHeader.decode(buf, base);
  const [channel, frame] = [7, 123];
  const byteOffset = base + 64 + (channel * bh.frameCount + frame) * 4;
  buf.writeFloatLE(buf.readFloatLE(byteOffset) + 1, byteOffset);
  blockHeader.encode(buf, base, { ...bh, payloadCrc32c: crc32c(buf, base + 64, base + 64 + bh.payloadBytes) });
  const file = tmp('incorrect');
  fs.writeFileSync(file, buf);
  const r = validate(file);
  check('incorrect → exit', r.exitCode, 1);
  check('incorrect → exactly one value', r.incorrect, 1);
  check('incorrect → not corrupt', r.corrupt, 0);
  check('incorrect → channel', r.firstDiscrepancy.incorrect?.channel, channel);
  check('incorrect → byte offset', r.firstDiscrepancy.incorrect?.byteOffset, byteOffset);
}
{
  const buf = Buffer.from(original);
  buf.writeFloatLE(99, off(2) + 64 + 40);
  const file = tmp('crc');
  fs.writeFileSync(file, buf);
  const r = validate(file);
  check('corrupt → exit', r.exitCode, 1);
  check('corrupt → count', r.corrupt, perBlock);
  check('corrupt → not reported as incorrect', r.incorrect, 0);
}
{
  const r = validate(src);
  check('control → unmodified file passes', r.result, 'PASS');
}

report(checks);
