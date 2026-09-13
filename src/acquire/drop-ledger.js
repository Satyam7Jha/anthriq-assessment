'use strict';
// Bounded, coalescing drop ledger. PLAN §7.6.
//
// The assessment forbids reporting loss as "a single aggregate flag" — it wants the POSITION. This
// structure is how that is satisfied, and its bounding is not incidental: an UNBOUNDED ledger is
// itself memory proportional to elapsed time, which is exactly what the assessment rules out. Under
// a pathologically flapping write path, drop events could arrive at a rate proportional to run
// duration, so the ledger is capped and says so when it caps.
//
// Coalescing: adjacent entries with the same cause merge, which collapses a sustained 30-second
// stall into ONE entry instead of thousands. That is what makes the cap generous in practice.

const D = require('../config/defaults');

const CAUSE = {
  GENERATOR_RING_FULL: 1,
  RECORDER_RING_FULL: 2,
  PACING_RESYNC: 3,
  TRANSPORT_GAP: 4,
  CORRUPT_FRAMES: 5,
  GENERATOR_DISCONNECT: 6,
  // Frames still in the ring when shutdown had to finalise metadata before the disk drained them.
  SHUTDOWN_UNFLUSHED: 7,
};
const CAUSE_NAME = Object.fromEntries(Object.entries(CAUSE).map(([k, v]) => [v, k]));

class DropLedger {
  constructor({ maxEntries = D.MAX_LEDGER_ENTRIES } = {}) {
    this.maxEntries = maxEntries;
    // Preallocated typed arrays: no per-entry object allocation, so a burst of drops does not also
    // create GC pressure at the moment the system is already under stress.
    this.starts = new BigUint64Array(maxEntries);
    this.counts = new Float64Array(maxEntries); // f64 holds exact integers to 2^53
    this.causes = new Uint8Array(maxEntries);
    this.count = 0;
    this.truncated = false;
    this.totalDroppedFrames = 0; // stays EXACT even if the enumeration is capped
  }

  /**
   * Record a dropped range. Always (startFrameIndex, frameCount) — never a bare count.
   * Returns true if the range was enumerated, false if only counted (ledger full).
   */
  record(startFrameIndex, frameCount, cause) {
    if (frameCount <= 0) return true;
    this.totalDroppedFrames += frameCount;

    if (this.count > 0) {
      const i = this.count - 1;
      const prevStart = Number(this.starts[i]);
      const prevCount = this.counts[i];
      if (this.causes[i] === cause && prevStart + prevCount === startFrameIndex) {
        this.counts[i] = prevCount + frameCount; // coalesce
        return true;
      }
    }
    if (this.count >= this.maxEntries) {
      // Counts stay correct; only the enumeration of positions is capped, and the file says so via
      // the LEDGER_TRUNCATED header flag. Documented rather than hidden.
      this.truncated = true;
      return false;
    }
    this.starts[this.count] = BigInt(startFrameIndex);
    this.counts[this.count] = frameCount;
    this.causes[this.count] = cause;
    this.count++;
    return true;
  }

  get isEmpty() {
    return this.totalDroppedFrames === 0;
  }

  entries() {
    const out = [];
    for (let i = 0; i < this.count; i++) {
      out.push({
        startFrameIndex: Number(this.starts[i]),
        frameCount: this.counts[i],
        cause: CAUSE_NAME[this.causes[i]] ?? `unknown(${this.causes[i]})`,
        causeCode: this.causes[i],
      });
    }
    return out;
  }

  /**
   * The sidecar JSON shape. Both frame- and value-indexed positions are emitted because the
   * assessment speaks in samples (= values) while the format addresses frames; printing both removes
   * any ambiguity for a third party.
   */
  toJSON({ channelCount, sampleRateHz }) {
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

module.exports = { DropLedger, CAUSE, CAUSE_NAME };
