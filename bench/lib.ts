// Shared helpers for the fault benches: run the tools as real processes, as a user would.

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';

export const ROOT = path.join(import.meta.dirname, '..');
export const bin = (name: string): string => path.join(ROOT, 'bin', `${name}.ts`);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ValidatorJson {
  exitCode: number;
  result: string;
  expectedValues: number;
  recordedValues: number;
  missing: number;
  duplicated: number;
  incorrect: number;
  corrupt: number;
  declaredDroppedValues: number | null;
  ledgerAgreesWithDerivedGaps: boolean | null;
  firstDiscrepancy: Record<string, Record<string, number> | null>;
}

/** Run the validator; a non-zero exit is an expected outcome, not an error. */
export function validate(file: string): ValidatorJson {
  try {
    return JSON.parse(execFileSync(process.execPath, [bin('sigval'), file, '--json'], { encoding: 'utf8' }));
  } catch (e) {
    return JSON.parse((e as { stdout: string }).stdout);
  }
}

export function start(name: string, args: string[], stderr: 'pipe' | 'ignore' = 'ignore'): ChildProcess {
  return spawn(process.execPath, [bin(name), ...args], { stdio: ['ignore', 'ignore', stderr] });
}

export const exitOf = (child: ChildProcess) => new Promise<number | null>((r) => child.on('exit', r));

/** Print a check list and exit non-zero if any failed. */
export function report(checks: [string, boolean][]): never {
  let bad = 0;
  console.log('');
  for (const [name, ok] of checks) {
    if (!ok) bad++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  }
  console.log(`\n  ${bad === 0 ? 'ALL CHECKS PASSED' : `${bad} CHECK(S) FAILED`}`);
  process.exit(bad === 0 ? 0 : 1);
}
