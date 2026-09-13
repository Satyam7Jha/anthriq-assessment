'use strict';
// Min/max envelope decimation. PLAN §11.2. PURE — no I/O, no state.
//
// WHY min/max and not subsampling or averaging. At 4,000 Hz on a 1,000 px trace showing 10 s, each
// pixel column covers 40 samples. Rendering every value is not merely expensive, it is
// information-theoretically pointless. The question is only how to throw data away CORRECTLY:
//
//   subsample / nearest    shows a transient only if it happens to land on the sample point
//   mean / RMS             smooths a transient away entirely
//   min/max envelope       a single-sample spike still extends its column's extent — NEVER hidden
//
// This is the standard audio-editor waveform algorithm, and it is the right one here for the same
// reason: in an instrument context the spike IS the signal of interest. An artefact that a viewer
// silently smoothed away would be worse than no viewer.
//
// Decimation runs in the UI SERVER, not the browser: the browser then receives 2*width floats per
// channel instead of 4,000 per channel-second — a ~200x reduction in bytes crossing the boundary —
// and the comparison loop never competes with rendering on the main thread.

/**
 * @param {Float32Array} samples     source, one channel
 * @param {number} columns           target pixel columns
 * @param {Float32Array} out         destination, length >= columns*2, written as [min0,max0,min1,...]
 * @returns {{columns:number, samplesPerColumn:number, min:number, max:number, rms:number, flatColumns:number}}
 */
function envelope(samples, columns, out) {
  const n = samples.length;
  if (n === 0 || columns <= 0) return { columns: 0, samplesPerColumn: 0, min: 0, max: 0, rms: 0, flatColumns: 0 };
  const cols = Math.min(columns, Math.max(1, n)); // never invent columns we have no samples for
  let gMin = Infinity;
  let gMax = -Infinity;
  let sumSq = 0;
  let counted = 0;
  let flatColumns = 0;

  for (let c = 0; c < cols; c++) {
    // Compute bounds from the column index rather than accumulating a step, so rounding error
    // cannot make the last column read past the end of the array.
    const lo = Math.floor((c * n) / cols);
    const hi = Math.max(lo + 1, Math.floor(((c + 1) * n) / cols));
    // NaN marks a sample that does not exist (lost data). Comparisons with NaN are false, so NaN
    // samples are skipped naturally; a column with no real samples at all is emitted as NaN, which
    // the renderer draws as nothing — a gap stays a gap instead of a line drawn through it.
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
      out[c * 2] = NaN;
      out[c * 2 + 1] = NaN;
      continue;
    }
    out[c * 2] = mn;
    out[c * 2 + 1] = mx;
    if (mn < gMin) gMin = mn;
    if (mx > gMax) gMax = mx;
    if (mx - mn < 1e-7) flatColumns++;
  }
  return {
    columns: cols,
    samplesPerColumn: n / cols,
    min: gMin,
    max: gMax,
    rms: counted ? Math.sqrt(sumSq / counted) : 0,
    flatColumns,
  };
}

/**
 * Per-channel quality indicators, computed from the same pass. PLAN §11.9.
 *
 * These are SYNTHETIC metrics, clearly labelled as such in the UI. On real hardware this column is
 * electrode-skin impedance, measured by injecting a small AC current on the ADS1299's lead-off
 * detection pins — the first thing a technician looks at, because a high-impedance electrode
 * produces a trace that looks like signal and is not. There is no electrode here, so reporting an
 * impedance number would be a lie; these are the honest analogues of what that column is FOR.
 */
function quality(stats, { railLimit = 4 } = {}) {
  const span = stats.max - stats.min;
  return {
    rms: stats.rms,
    peakToPeak: span,
    // FLAT: a disconnected or shorted electrode, in hardware terms.
    flat: stats.columns > 0 && stats.flatColumns / stats.columns > 0.9,
    // RAIL: amplifier saturation. Against the display limit, since that is what "clipped" means here.
    railed: stats.max >= railLimit || stats.min <= -railLimit,
  };
}

module.exports = { envelope, quality };
