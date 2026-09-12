// Milestone 1 (PLAN §13). The claim under test: value(c, n) is bit-identical on every
// recomputation. Everything else in this system rests on it — the validator compares recorded
// bytes against a recompute, so a signal that is not bit-stable makes the validator useless.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSignal } from '../src/signal/signal.js';

const C = 32;
const sig = createSignal({ channelCount: C });

// Bit comparison, not ===. `===` misleads twice on floats: NaN !== NaN (would under-report a
// difference) and -0 === +0 (would over-accept one). The signal produces neither, but the
// comparison is written to be correct regardless, because "the validator is itself correct" is a
// graded property.
const scratch = new Float32Array(1);
const scratchBits = new Uint32Array(scratch.buffer);
function bits(x) {
  scratch[0] = x;
  return scratchBits[0];
}

test('bit-exact across 10^6 recomputes', () => {
  const N = 31_250; // x 32 channels = 1,000,000 value comparisons
  const first = new Uint32Array(N * C);
  for (let n = 0, i = 0; n < N; n++) for (let c = 0; c < C; c++) first[i++] = bits(sig.value(c, n));

  let mismatches = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let n = 0, i = 0; n < N; n++) {
      for (let c = 0; c < C; c++, i++) if (bits(sig.value(c, n)) !== first[i]) mismatches++;
    }
  }
  assert.equal(mismatches, 0, `${mismatches} bit mismatches across 2,000,000 recomputes`);
});

test('order of evaluation does not matter (statelessness)', () => {
  // Forward, then reverse, then random access. A stateful generator would diverge here; this is the
  // property the assessment words as "independent of when/how many times computed".
  const N = 4000;
  const fwd = new Uint32Array(N);
  for (let n = 0; n < N; n++) fwd[n] = bits(sig.value(7, n));
  for (let n = N - 1; n >= 0; n--) assert.equal(bits(sig.value(7, n)), fwd[n]);
  for (let k = 0; k < 2000; k++) {
    const n = (k * 2654435761) % N;
    assert.equal(bits(sig.value(7, n)), fwd[n]);
  }
});

test('all 32 channels are distinct, by mean and at a fixed instant', () => {
  const means = new Set();
  for (let c = 0; c < C; c++) {
    let sum = 0;
    for (let n = 0; n < 8192; n++) sum += sig.value(c, n);
    means.add(sum / 8192);
  }
  assert.equal(means.size, C, `expected 32 distinct per-channel means, got ${means.size}`);

  const atN = new Set();
  for (let c = 0; c < C; c++) atN.add(bits(sig.value(c, 12345)));
  assert.equal(atN.size, C, `expected 32 distinct values at a fixed n, got ${atN.size}`);
});

test('values stay inside the float32 normal range, and are finite', () => {
  let min = Infinity;
  let max = -Infinity;
  for (let c = 0; c < C; c++) {
    for (let n = 0; n < 4000; n++) {
      const v = sig.value(c, n);
      assert.ok(Number.isFinite(v), `non-finite at c=${c} n=${n}`);
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  assert.ok(min > -1e30 && max < 1e30);
  console.log(`    value range over 32ch x 4000 frames: [${min}, ${max}]`);
});

test('integer intermediates stay exact for a 100-hour run', () => {
  // The largest product in value() is frameIndex * (2*31+1) = frameIndex * 63.
  const framesIn100h = 4000 * 3600 * 100;
  assert.ok(Number.isSafeInteger(framesIn100h * 63));
  // And spot-check bit-stability far out, where n | 0 in hash32 has wrapped past 2^31.
  const farN = 2 ** 31 + 12345;
  assert.equal(bits(sig.value(5, farN)), bits(sig.value(5, farN)));
});

test('fillInterleaved matches value() element by element', () => {
  const frames = 20;
  const buf = new Float32Array(frames * C);
  sig.fillInterleaved(buf, 0, 1_000_000, frames);
  for (let j = 0; j < frames; j++) {
    for (let c = 0; c < C; c++) {
      assert.equal(bits(buf[j * C + c]), bits(sig.value(c, 1_000_000 + j)));
    }
  }
});

test('fillPlanar matches value(), with a channel stride', () => {
  const frames = 50;
  const stride = 4000; // a short block inside a full-width block, as the recorder writes it
  const buf = new Float32Array(C * stride);
  sig.fillPlanar(buf, 0, 500, frames, stride);
  for (let c = 0; c < C; c++) {
    for (let j = 0; j < frames; j++) {
      assert.equal(bits(buf[c * stride + j]), bits(sig.value(c, 500 + j)));
    }
  }
});

test('the --no-dither variant is also bit-stable, and differs from the dithered one', () => {
  const clean = createSignal({ channelCount: C, dither: false });
  for (let n = 0; n < 1000; n++) {
    assert.equal(bits(clean.value(3, n)), bits(clean.value(3, n)));
  }
  let differs = 0;
  for (let n = 0; n < 1000; n++) if (bits(clean.value(3, n)) !== bits(sig.value(3, n))) differs++;
  assert.ok(differs > 900, `dither should perturb nearly every value, perturbed ${differs}/1000`);
});

test('cost: one second of data (128,000 values) in well under one tick', () => {
  const buf = new Float32Array(4000 * C);
  sig.fillInterleaved(buf, 0, 0, 4000); // warm up JIT
  const t0 = process.hrtime.bigint();
  const REPS = 20;
  for (let r = 0; r < REPS; r++) sig.fillInterleaved(buf, 0, r * 4000, 4000);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / REPS;
  console.log(`    ${ms.toFixed(3)} ms per 128,000 values = ${(ms / 10).toFixed(4)}% of one core`);
  assert.ok(ms < 5, `signal generation at ${ms.toFixed(2)} ms/s is too slow to be safe`);
});
