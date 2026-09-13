import { n } from '../util/fmt.ts';
import type { Discrepancy, ValidationResult } from './validate.ts';

/**
 * The six result lines, matching the brief's representative output exactly — spelling, order,
 * alignment, thousands separators. Printed first even on failure, so scripts parsing them keep working.
 */
export function resultLines(r: ValidationResult): string {
  const lines = [
    `Expected: ${n(r.expectedValues)} samples`,
    `Recorded: ${n(r.recordedValues)} samples`,
    `Missing:   ${n(r.missing)}`,
    `Duplicated: ${n(r.duplicated)}`,
    `Incorrect:  ${n(r.incorrect)}`,
    `Result: ${r.result}`,
  ];
  if (r.corrupt > 0) lines.push(`Corrupt:    ${n(r.corrupt)}   (CRC-failed blocks, counted separately)`);
  return `${lines.join('\n')}\n`;
}

const where = (d: Discrepancy): string =>
  `value #${n(Number(d.valueIndex))}  (channel ${d.channel ?? 0}, frame ${n(Number(d.frameIndex))}, t=${Number(d.timeSeconds).toFixed(6)}s)`;

/** First position of each discrepancy class, plus the ledger cross-check. */
export function detailLines(r: ValidationResult): string {
  const { missing, duplicated, incorrect, corrupt } = r.firstDiscrepancy;
  const lines = [''];
  if (missing) lines.push(`First missing:    ${where(missing)}`, `                  ${n(Number(missing.valueCount))} values`);
  if (duplicated) lines.push(`First duplicated: ${where(duplicated)}`);
  if (incorrect) lines.push(`First incorrect:  ${where(incorrect)}`, `                  expected ${incorrect.expected}, got ${incorrect.actual}, byte offset ${n(Number(incorrect.byteOffset))}`);
  if (corrupt) lines.push(`First corrupt:    block #${corrupt.blockIndex} at byte ${n(Number(corrupt.byteOffset))}`);
  if (r.truncated) lines.push(`Truncation:       file is ${r.finalised ? 'finalised but short' : 'NOT finalised'}; ${n(r.blockCount)} whole blocks read`);
  if (r.ledgerAgreesWithDerivedGaps !== null && (r.declaredDroppedValues! > 0 || r.missing > 0)) {
    // Two independent derivations of the same fact: the recorder's ledger and the gaps found here.
    lines.push(`Drop ledger:      header declares ${n(r.declaredDroppedValues!)} dropped values, validator derived ${n(r.missing)} — ${r.ledgerAgreesWithDerivedGaps ? 'AGREE' : 'DISAGREE: the recording contradicts itself'}`);
  }
  return `${lines.join('\n')}\n`;
}

export function summaryLine(r: ValidationResult): string {
  return `validated ${n(r.recordedValues)} values in ${r.elapsedSeconds.toFixed(2)} s (${n(r.throughputValuesPerSecond)} values/s), peak RSS ${(r.peakRssBytes / 1048576).toFixed(1)} MiB, CRC ${r.crcChecked ? 'on' : 'off'}\n`;
}
