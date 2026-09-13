// The deterministic signal.
//
// CONTRACT: value(c, n) is a pure, closed-form function of (channel, frameIndex) that is
// BIT-IDENTICAL on every recomputation, in any process, on any conforming engine, at any later time.
//
// Why not a sine wave: ECMAScript specifies Math.sin/cos/exp/pow/log only as
// "implementation-approximated", and V8 has changed its Math.sin before. A sine waveform is not
// reproducibly bit-exact, so a validator recomputing it under another Node build could report
// spurious "Incorrect" values. This waveform uses only operations IEEE-754 requires to be correctly
// rounded: + - * / %, Math.abs, Math.fround and 32-bit integer ops.
//
// Integer safety: the largest intermediate is frameIndex * 63. A 100-hour run at 4 kHz reaches
// 1.44e9 frames, so the product is 9.07e10, far below 2^53. Asserted in the tests.

import { hash32 } from './hash32.ts';
import { DEFAULTS } from '../config/defaults.ts';

export const SIGNAL_ID = DEFAULTS.SIGNAL_ID;
const TWO16 = 65536; // a power of two, so division by it is exact
const TWO32 = 4294967296;

/**
 *   tri  triangle carrier, period 65536/k1 frames; k1 is odd and distinct per channel, so the traces
 *        have visibly different frequencies (16.4 s on ch0 down to 0.26 s on ch31)
 *   saw  a second, decorrelated sawtooth with a per-channel phase offset
 *   a1   per-channel amplitude 0.500 .. 0.984;  c/32  per-channel DC offset
 *   dit  deterministic dither: hash32 is a pure function of (c, n). It makes the float32 mantissa
 *        non-trivial, so a validator comparing only high bits cannot pass by accident.
 */
function carrier(c: number, n: number): number {
  const k1 = 2 * c + 1;
  const k2 = 2 * ((c * 7) & 31) + 3;
  const t1 = ((n * k1) % TWO16) / TWO16;
  const t2 = ((n * k2 + (c << 9)) % TWO16) / TWO16;
  const tri = 4 * Math.abs(t1 - 0.5) - 1;
  const saw = 2 * t2 - 1;
  return (0.5 + c / 64) * tri + 0.25 * saw;
}

export function valueDithered(c: number, n: number): number {
  const dit = hash32(c, n) / TWO32 - 0.5;
  return Math.fround(carrier(c, n) + 0.03125 * dit + c / 32);
}

export function valueClean(c: number, n: number): number {
  return Math.fround(carrier(c, n) + c / 32);
}

export interface Signal {
  channelCount: number;
  dither: boolean;
  signalId: string;
  value: (c: number, n: number) => number;
  /** WIRE layout: [f0c0 f0c1 .. f0cC-1][f1c0 ..]. Allocates nothing. */
  fillInterleaved: (out: Float32Array, outOffset: number, startFrameIndex: number, frameCount: number) => number;
  /** FILE layout: [ch0 x F][ch1 x F].. with a channel stride of `frameStride` values. */
  fillPlanar: (out: Float32Array, outOffset: number, startFrameIndex: number, frameCount: number, frameStride?: number) => number;
}

/** Bind a signal to one configuration; the validator builds a matching one from the file header. */
export function createSignal({ channelCount, dither = true }: { channelCount: number; dither?: boolean }): Signal {
  if (!Number.isInteger(channelCount) || channelCount < 1) {
    throw new RangeError(`channelCount must be a positive integer, got ${channelCount}`);
  }
  const value = dither ? valueDithered : valueClean;
  return {
    channelCount,
    dither,
    signalId: SIGNAL_ID,
    value,
    fillInterleaved(out, outOffset, startFrameIndex, frameCount) {
      let w = outOffset;
      for (let j = 0; j < frameCount; j++) {
        const n = startFrameIndex + j;
        for (let c = 0; c < channelCount; c++) out[w++] = value(c, n);
      }
      return frameCount * channelCount;
    },
    fillPlanar(out, outOffset, startFrameIndex, frameCount, frameStride = frameCount) {
      for (let c = 0; c < channelCount; c++) {
        let w = outOffset + c * frameStride;
        for (let j = 0; j < frameCount; j++) out[w++] = value(c, startFrameIndex + j);
      }
      return channelCount * frameStride;
    },
  };
}
