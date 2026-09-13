// Bounded, coalescing drop ledger (PLAN §7.6).
//
// The brief wants the POSITION of loss, not a flag. The bound is not incidental: an unbounded ledger
// is itself memory proportional to elapsed time. Adjacent same-cause ranges coalesce, so a sustained
// stall is one entry; if the cap is ever reached, counts stay exact and the file says so.

import { DEFAULTS as D } from '../config/defaults.ts';

export const CAUSE = {
  GENERATOR_RING_FULL: 1,
  RECORDER_RING_FULL: 2,
  PACING_RESYNC: 3,
  TRANSPORT_GAP: 4,
  CORRUPT_FRAMES: 5,
  GENERATOR_DISCONNECT: 6,
  SHUTDOWN_UNFLUSHED: 7, // frames still in the ring when shutdown had to finalise without them
} as const;

export type CauseCode = (typeof CAUSE)[keyof typeof CAUSE];

export const CAUSE_NAME: Record<number, string> = Object.fromEntries(Object.entries(CAUSE).map(([k, v]) => [v, k]));

export interface LedgerEntry {
  startFrameIndex: number;
  frameCount: number;
  cause: string;
  causeCode: number;
}

export class DropLedger {
  readonly maxEntries: number;
  // Preallocated, so a burst of drops creates no GC pressure at the moment the system is stressed.
  #starts: Float64Array; // f64 holds exact integers to 2^53
  #counts: Float64Array;
  #causes: Uint8Array;
  count = 0;
  truncated = false;
  totalDroppedFrames = 0; // exact even when the enumeration is capped

  constructor(maxEntries: number = D.MAX_LEDGER_ENTRIES) {
    this.maxEntries = maxEntries;
    this.#starts = new Float64Array(maxEntries);
    this.#counts = new Float64Array(maxEntries);
    this.#causes = new Uint8Array(maxEntries);
  }

  /** Record a dropped range — always (start, count), never a bare total. */
  record(startFrameIndex: number, frameCount: number, cause: CauseCode): void {
    if (frameCount <= 0) return;
    this.totalDroppedFrames += frameCount;
    const i = this.count - 1;
    if (i >= 0 && this.#causes[i] === cause && this.#starts[i] + this.#counts[i] === startFrameIndex) {
      this.#counts[i] += frameCount;
      return;
    }
    if (this.count >= this.maxEntries) {
      this.truncated = true;
      return;
    }
    this.#starts[this.count] = startFrameIndex;
    this.#counts[this.count] = frameCount;
    this.#causes[this.count] = cause;
    this.count++;
  }

  entries(): LedgerEntry[] {
    return Array.from({ length: this.count }, (_, i) => ({
      startFrameIndex: this.#starts[i],
      frameCount: this.#counts[i],
      cause: CAUSE_NAME[this.#causes[i]] ?? `unknown(${this.#causes[i]})`,
      causeCode: this.#causes[i],
    }));
  }

  /** Sidecar shape, with both frame- and value-indexed positions so neither reading is ambiguous. */
  toJSON({ channelCount, sampleRateHz }: { channelCount: number; sampleRateHz: number }) {
    return {
      ledgerTruncated: this.truncated,
      totalDroppedFrames: this.totalDroppedFrames,
      totalDroppedValues: this.totalDroppedFrames * channelCount,
      entries: this.entries().map((e) => ({
        startFrameIndex: e.startFrameIndex,
        frameCount: e.frameCount,
        startValueIndex: e.startFrameIndex * channelCount,
        valueCount: e.frameCount * channelCount,
        startSeconds: e.startFrameIndex / sampleRateHz,
        durationSeconds: e.frameCount / sampleRateHz,
        cause: e.cause,
      })),
    };
  }
}
