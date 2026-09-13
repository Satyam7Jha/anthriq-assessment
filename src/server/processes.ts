// Child processes the server starts: the validator, and the recorder/generator pair.
// Each runs as its own process. The validator's independence is what makes its verdict worth anything.

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const BIN = path.join(import.meta.dirname, '..', '..', 'bin');

export const binPath = (name: string): string => path.join(BIN, `${name}.ts`);

export interface ValidatorOutcome {
  exitCode: number | null;
  report: Record<string, unknown> | null;
  stderr: string;
}

export function runValidator(file: string): Promise<ValidatorOutcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [binPath('sigval'), file, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (exitCode) => {
      let report = null;
      try {
        report = JSON.parse(out);
      } catch {
        // refused before producing JSON; exitCode and stderr say why
      }
      resolve({ exitCode, report, stderr: err.slice(-2000) });
    });
  });
}

/** Resolves true when the child has exited, false if it is still running after `ms`. */
export function exited(child: ChildProcess, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}
