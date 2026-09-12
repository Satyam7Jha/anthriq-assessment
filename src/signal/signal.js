'use strict';
// The deterministic signal definition. PLAN §5.
//
// CONTRACT (this is the load-bearing property of the whole submission):
//   value(c, n) is a pure, closed-form function of (channel, frameIndex) that is BIT-IDENTICAL
//   on every recomputation, in any process, on any conforming engine, at any later time.
//
// Why not a sine wave. ECMAScript specifies Math.sin/cos/exp/pow/log only as
// "implementation-approximated". V8 has changed its Math.sin implementation historically (the 2016
// fdlibm port), and nothing guarantees identical results across V8 versions or architectures. A
// sine-based waveform is therefore NOT reproducibly bit-exact, and a validator recomputing it under
// a different Node build could report spurious "Incorrect" values. This waveform is built
// exclusively from operations IEEE-754 requires to be correctly rounded and that ECMAScript
// inherits verbatim: + - * / %, Math.abs, Math.fround, and 32-bit integer ops.
//
// Integer safety: the largest intermediate is frameIndex * 63. A 100-hour run at 4 kHz reaches
// frameIndex 1.44e9, so the product is 9.07e10 << 2^53. Asserted in the test suite, not assumed.
//
// Pure. Imports nothing but hash32. No fs, no net (enforced by tools/check-layering.mjs).

const { hash32 } = require('./hash32');
const { SIGNAL_ID } = require('../config/defaults');

const TWO16 = 65536; // power of two => division by it is exact
const TWO32 = 4294967296;

/**
 * value(c, n) -> a Number that is already exactly representable as float32.
 *
 * Components, each serving a stated purpose:
 *   tri  triangle carrier, period 65536/k1 frames. k1 is odd and distinct per channel, so the
 *        32 traces have visibly different frequencies (16.4 s on ch0 down to 0.26 s on ch31).
 *   saw  a second, decorrelated sawtooth component with a per-channel phase offset.
 *   a1   per-channel amplitude, 0.500 .. 0.984.
 *   c/32 per-channel DC offset, so a stacked trace view separates cleanly.
 *   dit  deterministic dither. NOT noise: hash32 is a pure function of (c, n). Its job is to make
 *        the float32 mantissa non-trivial, so that a validator bug which compares only the high
 *        bits cannot pass by accident.
 */
function valueDithered(c, n) {
  const k1 = 2 * c + 1; // odd => distinct period per channel
  const k2 = 2 * ((c * 7) & 31) + 3; // a second, decorrelated rate
  const p1 = (n * k1) % TWO16; // exact integer modulo
  const p2 = (n * k2 + (c << 9)) % TWO16; // per-channel phase offset
  const t1 = p1 / TWO16; // exact: 16-bit integer / 2^16
  const t2 = p2 / TWO16;
  const tri = 4 * Math.abs(t1 - 0.5) - 1; // triangle, [-1, 1]
  const saw = 2 * t2 - 1; // sawtooth, [-1, 1]
  const a1 = 0.5 + c / 64; // per-channel amplitude
  const dit = hash32(c, n) / TWO32 - 0.5; // deterministic dither, [-0.5, 0.5)
  return Math.fround(a1 * tri + 0.25 * saw + 0.03125 * dit + c / 32);
}

/** The --no-dither variant. Same carrier, no mantissa exercise. Recorded in the header flags. */
function valueClean(c, n) {
  const k1 = 2 * c + 1;
  const k2 = 2 * ((c * 7) & 31) + 3;
  const p1 = (n * k1) % TWO16;
  const p2 = (n * k2 + (c << 9)) % TWO16;
  const t1 = p1 / TWO16;
  const t2 = p2 / TWO16;
  const tri = 4 * Math.abs(t1 - 0.5) - 1;
  const saw = 2 * t2 - 1;
  const a1 = 0.5 + c / 64;
  return Math.fround(a1 * tri + 0.25 * saw + c / 32);
}

/**
 * Build a signal bound to one configuration. The factory exists so that the dither flag is fixed
 * once — the validator reads it from the file header and constructs a matching signal, rather than
 * threading a boolean through every inner loop.
 */
function createSignal({ channelCount, dither = true } = {}) {
  if (!Number.isInteger(channelCount) || channelCount < 1) {
    throw new RangeError(`channelCount must be a positive integer, got ${channelCount}`);
  }
  const value = dither ? valueDithered : valueClean;

  /**
   * Fill a Float32Array with INTERLEAVED frames: [f0c0 f0c1 .. f0cC-1][f1c0 ..]
   * This is the WIRE layout (PLAN §4.2) — the recorder's gap detector wants whole frames.
   * Writes frameCount*channelCount values starting at `outOffset`. Allocates nothing.
   */
  function fillInterleaved(out, outOffset, startFrameIndex, frameCount) {
    let w = outOffset;
    for (let j = 0; j < frameCount; j++) {
      const n = startFrameIndex + j;
      for (let c = 0; c < channelCount; c++) out[w++] = value(c, n);
    }
    return frameCount * channelCount;
  }

  /**
   * Fill a Float32Array PLANAR within the block: [ch0 x F][ch1 x F].. with a channel stride of
   * `frameStride` values. This is the FILE layout (PLAN §8.4) — readers want channel-contiguous
   * runs so a channel subset costs k/C of the bytes. Used by the validator and by fixtures.
   */
  function fillPlanar(out, outOffset, startFrameIndex, frameCount, frameStride = frameCount) {
    for (let c = 0; c < channelCount; c++) {
      let w = outOffset + c * frameStride;
      for (let j = 0; j < frameCount; j++) out[w++] = value(c, startFrameIndex + j);
    }
    return channelCount * frameStride;
  }

  return { value, fillInterleaved, fillPlanar, channelCount, dither, signalId: SIGNAL_ID };
}

module.exports = { createSignal, valueDithered, valueClean, SIGNAL_ID };
