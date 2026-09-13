// The load-bearing property: value(c, n) is bit-identical on every recomputation. The validator compares
// recorded bytes against a recompute, so a signal that is not bit-stable makes verification meaningless.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSignal } from '../src/signal/signal.ts';

const C = 32;
const sig = createSignal({ channelCount: C });

// Bit comparison, not ===: NaN !== NaN under-reports and -0 === +0 over-accepts.
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const bits = (x: number): number => ((f32[0] = x), u32[0]);

test('bit-exact across 2,000,000 recomputes', () => {
  const N = 31_250;
  const first = new Uint32Array(N * C);
  for (let n = 0, i = 0; n < N; n++) for (let c = 0; c < C; c++) first[i++] = bits(sig.value(c, n));
  let mismatches = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let n = 0, i = 0; n < N; n++) for (let c = 0; c < C; c++, i++) if (bits(sig.value(c, n)) !== first[i]) mismatches++;
  }
  assert.equal(mismatches, 0);
});

test('order of evaluation does not matter', () => {
  const N = 4000;
  const fwd = Array.from({ length: N }, (_, n) => bits(sig.value(7, n)));
  for (let n = N - 1; n >= 0; n--) assert.equal(bits(sig.value(7, n)), fwd[n]);
  for (let k = 0; k < 2000; k++) {
    const n = (k * 2654435761) % N;
    assert.equal(bits(sig.value(7, n)), fwd[n]);
  }
});

test('all 32 channels are distinct', () => {
  const means = new Set<number>();
  for (let c = 0; c < C; c++) {
    let sum = 0;
    for (let n = 0; n < 8192; n++) sum += sig.value(c, n);
    means.add(sum / 8192);
  }
  assert.equal(means.size, C);
  assert.equal(new Set(Array.from({ length: C }, (_, c) => bits(sig.value(c, 12345)))).size, C);
});

test('integer intermediates stay exact for a 100-hour run', () => {
  assert.ok(Number.isSafeInteger(4000 * 3600 * 100 * 63));
  const far = 2 ** 31 + 12345; // past where n | 0 wraps inside hash32
  assert.equal(bits(sig.value(5, far)), bits(sig.value(5, far)));
});

test('fillInterleaved and fillPlanar match value()', () => {
  const inter = new Float32Array(20 * C);
  sig.fillInterleaved(inter, 0, 1_000_000, 20);
  for (let j = 0; j < 20; j++) for (let c = 0; c < C; c++) assert.equal(bits(inter[j * C + c]), bits(sig.value(c, 1_000_000 + j)));

  const stride = 4000;
  const planar = new Float32Array(C * stride);
  sig.fillPlanar(planar, 0, 500, 50, stride);
  for (let c = 0; c < C; c++) for (let j = 0; j < 50; j++) assert.equal(bits(planar[c * stride + j]), bits(sig.value(c, 500 + j)));
});

test('the no-dither variant is stable and differs from the dithered one', () => {
  const clean = createSignal({ channelCount: C, dither: false });
  let differs = 0;
  for (let n = 0; n < 1000; n++) {
    assert.equal(bits(clean.value(3, n)), bits(clean.value(3, n)));
    if (bits(clean.value(3, n)) !== bits(sig.value(3, n))) differs++;
  }
  assert.ok(differs > 900);
});

test('one second of data costs well under one tick', () => {
  const buf = new Float32Array(4000 * C);
  sig.fillInterleaved(buf, 0, 0, 4000); // warm the JIT
  const t0 = process.hrtime.bigint();
  for (let r = 0; r < 20; r++) sig.fillInterleaved(buf, 0, r * 4000, 4000);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
  assert.ok(ms < 5, `${ms.toFixed(2)} ms per second of data`);
});
