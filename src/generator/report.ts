import { n } from '../util/fmt.ts';
import type { PacingReport } from '../acquire/scheduler.ts';

type Summary = Omit<PacingReport, 'startTimestampUnixNanos' | 'startMonotonicNanos'> & {
  emittedValues: number;
  ringPeakBlocks: number;
  ringSlots: number;
  ringPeakFillPct: number;
  drainStalls: number;
  peakWritableLength: number;
  droppedFrames: number;
  droppedRanges: number;
};

/** The generator's final report. Deviation is a count identity; tick lag is the real measurement. */
export function formatPacingReport(s: Summary): string {
  return [
    '',
    '  generator — final pacing report',
    `    elapsed              ${s.elapsedSeconds.toFixed(3)} s`,
    `    emitted              ${n(s.emittedFrames)} frames = ${n(s.emittedValues)} values`,
    `    expected (clock)     ${n(s.expectedFrames)} frames`,
    `    deviation            ${s.deviationFrames} frames (${s.deviationPpm} ppm)`,
    `    tick lag             p50 <= ${s.tickLag.p50UsAtMost} us, p99 <= ${s.tickLag.p99UsAtMost} us, max ${s.tickLag.maxUs} us`,
    `    late ticks           ${n(s.lateTicks)} of ${n(s.ticks)}`,
    `    pacing resyncs       ${s.resyncCount} (${n(s.resyncFrames)} frames)`,
    `    ring peak            ${s.ringPeakBlocks}/${s.ringSlots} blocks (${s.ringPeakFillPct}%)`,
    `    drain stalls         ${n(s.drainStalls)}   peak socket queue ${n(s.peakWritableLength)} B`,
    `    dropped              ${n(s.droppedFrames)} frames in ${s.droppedRanges} range(s)`,
    '',
    '',
  ].join('\n');
}
