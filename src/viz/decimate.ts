// Min/max envelope decimation (PLAN §11.2). Pure.
//
// At 4 kHz on a 1,000 px trace showing 10 s, each pixel column covers 40 samples. Subsampling shows a
// transient only if it lands on a sample point; averaging erases it; a min/max envelope means a
// single-sample spike still extends its column and can never be hidden.

export interface EnvelopeStats {
  columns: number;
  samplesPerColumn: number;
  min: number;
  max: number;
  rms: number;
  flatColumns: number;
}

/**
 * Decimate `samples` into `columns` [min, max] pairs written to `out`. NaN marks lost data: NaN
 * samples are skipped, and a column with no real samples is emitted as NaN so a gap stays a gap.
 */
export function envelope(samples: Float32Array, columns: number, out: Float32Array): EnvelopeStats {
  const n = samples.length;
  if (n === 0 || columns <= 0) return { columns: 0, samplesPerColumn: 0, min: 0, max: 0, rms: 0, flatColumns: 0 };
  const cols = Math.min(columns, n); // never invent columns there are no samples for
  let gMin = Infinity;
  let gMax = -Infinity;
  let sumSq = 0;
  let counted = 0;
  let flatColumns = 0;

  for (let c = 0; c < cols; c++) {
    // Bounds from the column index, not an accumulated step, so rounding cannot overrun the array.
    const lo = Math.floor((c * n) / cols);
    const hi = Math.max(lo + 1, Math.floor(((c + 1) * n) / cols));
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = lo; i < hi; i++) {
      const v = samples[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      if (v === v) {
        sumSq += v * v;
        counted++;
      }
    }
    if (mn === Infinity) {
      out[c * 2] = out[c * 2 + 1] = NaN;
      continue;
    }
    out[c * 2] = mn;
    out[c * 2 + 1] = mx;
    gMin = Math.min(gMin, mn);
    gMax = Math.max(gMax, mx);
    if (mx - mn < 1e-7) flatColumns++;
  }
  return { columns: cols, samplesPerColumn: n / cols, min: gMin, max: gMax, rms: counted ? Math.sqrt(sumSq / counted) : 0, flatColumns };
}
