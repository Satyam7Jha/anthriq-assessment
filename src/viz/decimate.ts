// Min/max envelope decimation. Pure.
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
 *
 * With `samplesPerColumn`, every column covers exactly that many samples from the start of `samples`
 * (the last may hold fewer). A caller that also starts `samples` on a multiple of it gets columns on
 * an absolute grid: a moving window then shifts whole columns instead of re-binning them, so the trace
 * slides rather than shimmering.
 */
export function envelope(samples: Float32Array, columns: number, out: Float32Array, samplesPerColumn?: number): EnvelopeStats {
  const n = samples.length;
  if (n === 0 || columns <= 0) return { columns: 0, samplesPerColumn: 0, min: 0, max: 0, rms: 0, flatColumns: 0 };
  const spc = samplesPerColumn && samplesPerColumn >= 1 ? Math.floor(samplesPerColumn) : 0;
  const cols = spc ? Math.min(columns, Math.ceil(n / spc)) : Math.min(columns, n); // never invent columns there are no samples for
  let gMin = Infinity;
  let gMax = -Infinity;
  let sumSq = 0;
  let counted = 0;
  let flatColumns = 0;

  for (let c = 0; c < cols; c++) {
    // Bounds from the column index, not an accumulated step, so rounding cannot overrun the array.
    const lo = spc ? c * spc : Math.floor((c * n) / cols);
    const hi = spc ? Math.min(n, lo + spc) : Math.max(lo + 1, Math.floor(((c + 1) * n) / cols));
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
  return { columns: cols, samplesPerColumn: spc || n / cols, min: gMin, max: gMax, rms: counted ? Math.sqrt(sumSq / counted) : 0, flatColumns };
}
