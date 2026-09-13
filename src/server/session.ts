// Start and stop recordings from the browser.
//
// The server launches the recorder and the generator as two separate child processes and only sends
// them signals — it never joins their socket or writes the file. A recording made here comes from the
// same two processes as one made on the command line. When it stops, the validator runs on its own.
//
// States: idle -> recording -> stopping -> verifying -> done (-> recording again)

import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Logger } from '../util/logger.ts';
import type { RecordingView } from './recording-view.ts';
import type { Transport } from './transport.ts';
import { binPath, exited, runValidator, type ValidatorOutcome } from './processes.ts';

export interface SessionState {
  state: 'idle' | 'recording' | 'stopping' | 'verifying' | 'done';
  file: string | null;
  validation: ValidatorOutcome | null;
  error: string | null;
}

export function createSession(o: { view: RecordingView; transport: Transport; recordingsDir: string; channelCount: number; sampleRateHz: number; log: Logger }) {
  const state: SessionState = { state: o.view.path ? 'done' : 'idle', file: o.view.path ? path.basename(o.view.path) : null, validation: null, error: null };
  let children: { recorder: ChildProcess; generator: ChildProcess } | null = null;
  const busy = () => state.state === 'recording' || state.state === 'stopping' || state.state === 'verifying';

  async function start(): Promise<void> {
    if (busy()) return;
    fs.mkdirSync(o.recordingsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const out = path.join(o.recordingsDir, `recording-${stamp}.sigb`);
    const socket = `/tmp/sigacq-ui-${process.pid}.sock`;
    const shared = ['--channels', String(o.channelCount), '--rate', String(o.sampleRateHz), '--quiet'];

    const recorder = spawn(process.execPath, [binPath('recorder'), '--out', out, '--socket', socket, '--stats-interval', '1', '--stats-out', o.view.statsPathFor(out), ...shared], { stdio: 'ignore' });
    for (let i = 0; i < 60 && !fs.existsSync(socket); i++) await new Promise((r) => setTimeout(r, 50));
    if (!fs.existsSync(socket)) {
      recorder.kill('SIGKILL');
      state.error = 'The recorder did not start.';
      return;
    }
    const generator = spawn(process.execPath, [binPath('generator'), '--socket', socket, '--stats-interval', '0', ...shared], { stdio: 'ignore' });
    // Keep the machine awake while recording, as a media app would: an idle-sleep assertion held for
    // exactly the recorder's lifetime. Sleep suspends both processes, which the ledger would then
    // correctly record as gaps — but a recording started from the browser should not get them just
    // because nobody touched the trackpad. (Closing the lid still sleeps; that loss is still ledgered.)
    if (process.platform === 'darwin' && recorder.pid) spawn('caffeinate', ['-i', '-w', String(recorder.pid)], { stdio: 'ignore' }).on('error', () => {});
    children = { recorder, generator };
    o.view.setPath(out);
    o.transport.reset();
    Object.assign(state, { state: 'recording', file: path.basename(out), validation: null, error: null });
    o.log.info('session-start', { file: out, recorderPid: recorder.pid, generatorPid: generator.pid });

    recorder.once('exit', (code) => {
      if (state.state !== 'recording') return;
      state.error = `The recorder stopped unexpectedly (exit ${code}).`;
      void stop();
    });
  }

  async function stop(): Promise<void> {
    if (state.state !== 'recording' || !children) return;
    const { recorder, generator } = children;
    state.state = 'stopping';
    // Producer first, then the recorder through its clean shutdown, which finalises the file.
    generator.kill('SIGTERM');
    await exited(generator, 3000);
    if (recorder.exitCode === null) recorder.kill('SIGINT');
    if (!(await exited(recorder, 25_000))) recorder.kill('SIGKILL');
    children = null;
    o.view.invalidate();
    state.state = 'verifying';
    state.validation = await runValidator(o.view.path!);
    state.state = 'done';
    o.log.info('session-done', { file: o.view.path, exitCode: state.validation.exitCode });
  }

  /** On server exit: stop a running recording cleanly rather than orphan it. */
  async function shutdown(): Promise<void> {
    if (!children) return;
    children.generator.kill('SIGTERM');
    children.recorder.kill('SIGINT');
    await exited(children.recorder, 20_000);
  }

  return { state, start, stop, shutdown };
}

export type Session = ReturnType<typeof createSession>;
