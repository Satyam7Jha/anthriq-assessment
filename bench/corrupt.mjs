// Milestone 10 (PLAN §13). Deliberately damage a good recording three different ways and assert the
// validator reports the right CLASS, the right COUNT, and the right FIRST POSITION for each.
//
// This exists because an always-PASS validator is indistinguishable from `exit 0`. A submission
// that only ever shows a green validator has not demonstrated that the validator works — it has
// demonstrated that it runs.
//
// The three injections mirror real failure modes rather than arbitrary byte-flipping:
//   MISSING     a whole block is spliced OUT of the file. Every later block keeps its ABSOLUTE
//               startFrameIndex, so the gap appears exactly as a real dropped block would.
//   DUPLICATED  a block is re-inserted, so a startFrameIndex is seen twice — what a generator
//               restarting against a live recorder would produce.
//   INCORRECT   one float is altered and the block's payload CRC is REPAIRED, so the damage cannot
//               hide behind a CRC failure. This is the bit-rot-that-checksums-cannot-see case.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { FILE_HEADER_BYTES, BLOCK_HEADER_BYTES } = await import(`${root}/src/config/defaults.js`).then((m) => m.default ?? m);
const blockHeader = await import(`${root}/src/format/block-header.js`).then((m) => m.default ?? m);
const { crc32c } = await import(`${root}/src/format/crc32c.js`).then((m) => m.default ?? m);

const SRC = process.argv[2] ?? '/tmp/t.sigb';
const TMP = process.env.TMPDIR ?? '/tmp';

function runValidator(file) {
  try {
    const stdout = execFileSync('node', [`${root}/bin/sigval.js`, file, '--json'], { encoding: 'utf8' });
    return { code: 0, ...JSON.parse(stdout) };
  } catch (e) {
    // Non-zero exit is the expected outcome here — that is the point of the whole file.
    return { code: e.status, ...JSON.parse(e.stdout) };
  }
}

function readHeader(buf) {
  return {
    headerBytes: buf.readUInt16LE(10),
    channelCount: buf.readUInt32LE(32),
    blockStrideBytes: Number(buf.readBigUInt64LE(64)),
    framesPerBlock: buf.readUInt32LE(56),
  };
}

const original = fs.readFileSync(SRC);
const H = readHeader(original);
const blockCount = Math.floor((original.length - H.headerBytes) / H.blockStrideBytes);
assert.ok(blockCount >= 4, `need at least 4 blocks to corrupt, file has ${blockCount}`);
const off = (b) => H.headerBytes + b * H.blockStrideBytes;

console.log(`source: ${SRC}  (${blockCount} blocks, ${H.channelCount} ch, stride ${H.blockStrideBytes} B)\n`);

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`    ${ok ? 'ok  ' : 'FAIL'}  ${name}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
}

// ---------------------------------------------------------------- 1. MISSING
{
  const victim = 2;
  const out = path.join(TMP, 'corrupt-missing.sigb');
  // Splice the block out. Later blocks keep their absolute startFrameIndex, so the validator must
  // see a gap of exactly framesPerBlock at the victim's position.
  fs.writeFileSync(out, Buffer.concat([original.subarray(0, off(victim)), original.subarray(off(victim + 1))]));
  const r = runValidator(out);
  const expectMissingValues = H.framesPerBlock * H.channelCount;
  const expectFirstValueIndex = victim * H.framesPerBlock * H.channelCount;
  console.log('  MISSING — one whole block spliced out');
  check('exit code', r.code, 1);
  check('result', r.result, 'FAIL');
  check('missing values', r.missing, expectMissingValues);
  check('duplicated', r.duplicated, 0);
  check('incorrect', r.incorrect, 0);
  check('first missing value index', r.firstDiscrepancy.missing?.valueIndex, expectFirstValueIndex);
  check('first missing frame index', r.firstDiscrepancy.missing?.frameIndex, victim * H.framesPerBlock);
  console.log();
}

// ------------------------------------------------------------- 2. DUPLICATED
{
  const victim = 1;
  const out = path.join(TMP, 'corrupt-duplicated.sigb');
  const dup = original.subarray(off(victim), off(victim + 1));
  fs.writeFileSync(out, Buffer.concat([original.subarray(0, off(victim + 1)), dup, original.subarray(off(victim + 1))]));
  const r = runValidator(out);
  console.log('  DUPLICATED — one block written twice');
  check('exit code', r.code, 1);
  check('result', r.result, 'FAIL');
  check('duplicated values', r.duplicated, H.framesPerBlock * H.channelCount);
  check('missing', r.missing, 0);
  check('first duplicated value index', r.firstDiscrepancy.duplicated?.valueIndex, victim * H.framesPerBlock * H.channelCount);
  console.log();
}

// -------------------------------------------------------------- 3. INCORRECT
{
  const victim = 3;
  const channel = 7;
  const frameInBlock = 123;
  const out = path.join(TMP, 'corrupt-incorrect.sigb');
  const buf = Buffer.from(original);
  const base = off(victim);
  const payloadStart = base + BLOCK_HEADER_BYTES;
  const bh = blockHeader.decode(buf, base);
  // Planar within the block: value (c, j) lives at c*frameCount + j.
  const valueSlot = channel * bh.frameCount + frameInBlock;
  const byteOffset = payloadStart + valueSlot * 4;
  const before = buf.readFloatLE(byteOffset);
  buf.writeFloatLE(before + 1, byteOffset); // a change far larger than any rounding
  // REPAIR the CRC so the damage presents as an incorrect VALUE, not as a corrupt block. This is
  // the case a checksum cannot catch, and the case the value comparison exists for.
  blockHeader.encode(buf, base, {
    startFrameIndex: bh.startFrameIndex,
    frameCount: bh.frameCount,
    payloadBytes: bh.payloadBytes,
    blockIndex: bh.blockIndex,
    monotonicNanos: bh.monotonicNanos,
    flags: bh.flags,
    precedingGapFrames: bh.precedingGapFrames,
    payloadCrc32c: crc32c(buf, payloadStart, payloadStart + bh.payloadBytes),
  });
  fs.writeFileSync(out, buf);
  const r = runValidator(out);
  const frameIndex = bh.startFrameIndex + frameInBlock;
  console.log('  INCORRECT — one value altered, block CRC repaired so it cannot hide');
  check('exit code', r.code, 1);
  check('result', r.result, 'FAIL');
  check('incorrect values', r.incorrect, 1);
  check('corrupt values', r.corrupt, 0);
  check('missing', r.missing, 0);
  check('first incorrect channel', r.firstDiscrepancy.incorrect?.channel, channel);
  check('first incorrect frame index', r.firstDiscrepancy.incorrect?.frameIndex, frameIndex);
  check('first incorrect value index', r.firstDiscrepancy.incorrect?.valueIndex, frameIndex * H.channelCount + channel);
  check('reported byte offset', r.firstDiscrepancy.incorrect?.byteOffset, byteOffset);
  console.log();
}

// ------------------------------------------------- 4. CORRUPT (CRC not repaired)
{
  const victim = 2;
  const out = path.join(TMP, 'corrupt-crc.sigb');
  const buf = Buffer.from(original);
  buf.writeFloatLE(99, off(victim) + BLOCK_HEADER_BYTES + 40); // leave the CRC stale
  fs.writeFileSync(out, buf);
  const r = runValidator(out);
  console.log('  CORRUPT — a byte flipped with the CRC left stale');
  check('exit code', r.code, 1);
  check('corrupt values', r.corrupt, H.framesPerBlock * H.channelCount);
  // The whole point of the separate class: this must NOT be reported as 128,000 incorrect values.
  check('incorrect values', r.incorrect, 0);
  console.log();
}

// ------------------------------------------------------ 5. the control: unmodified
{
  const r = runValidator(SRC);
  console.log('  CONTROL — the unmodified file must still pass');
  check('exit code', r.code, 0);
  check('result', r.result, 'PASS');
  console.log();
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
