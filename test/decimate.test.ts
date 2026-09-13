// Envelopes on an absolute column grid: a moving window shifts whole columns instead of re-binning
// them. That is the difference between a trace that slides and one that shimmers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envelope } from '../src/viz/decimate.ts';

const signal = (n: number) => Float32Array.from({ length: n }, (_, i) => Math.sin(i * 0.37) + ((i * 7919) % 13) / 13);

test('grid-aligned columns are identical after the window moves by whole columns', () => {
  const spc = 40;
  const columns = 100;
  const all = signal(spc * (columns + 5));
  const a = new Float32Array(columns * 2);
  const b = new Float32Array(columns * 2);
  envelope(all.subarray(0, spc * columns), columns, a, spc);
  envelope(all.subarray(3 * spc, 3 * spc + spc * columns), columns, b, spc); // three columns later
  assert.deepEqual(b.subarray(0, (columns - 3) * 2), a.subarray(3 * 2), 'every overlapping column is unchanged');
});

test('without a grid, the same move re-bins columns — the shimmer the grid prevents', () => {
  const columns = 100;
  const all = signal(4000 + 50);
  const a = new Float32Array(columns * 2);
  const b = new Float32Array(columns * 2);
  envelope(all.subarray(0, 4000), columns, a);
  envelope(all.subarray(13, 4013), columns, b); // a move that is not a whole number of columns
  let changed = 0;
  for (let c = 0; c < columns - 1; c++) if (a[c * 2] !== b[c * 2] || a[c * 2 + 1] !== b[c * 2 + 1]) changed++;
  assert.ok(changed > columns / 4, `${changed} columns changed shape`);
});

test('a partly filled window uses whole columns from its start and leaves the last one short', () => {
  const spc = 40;
  const samples = signal(spc * 10 + 7);
  const out = new Float32Array(20 * 2).fill(Number.NaN);
  const stats = envelope(samples, 20, out, spc);
  assert.equal(stats.columns, 11, 'ten full columns and one of seven samples');
  assert.equal(stats.samplesPerColumn, spc);
  let lo = Infinity;
  for (let i = 400; i < 407; i++) lo = Math.min(lo, samples[i]);
  assert.equal(out[10 * 2], lo, 'the short column covers exactly its seven samples');
  assert.ok(Number.isNaN(out[11 * 2]), 'no column is invented past the data');
});

test('a spike inside a column still reaches its full height', () => {
  const spc = 40;
  const samples = new Float32Array(spc * 4);
  samples[spc * 2 + 17] = 5;
  const out = new Float32Array(8);
  envelope(samples, 4, out, spc);
  assert.equal(out[2 * 2 + 1], 5);
});
