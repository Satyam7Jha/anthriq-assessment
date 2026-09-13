// R11: "a slow or stalled consumer must not make the generator fall behind."
//
// SIGSTOP the recorder mid-run — a total stall, the process is not scheduled — and watch the
// generator's pacing before, during and after. Loss must be positioned ranges, and the validator,
// deriving gaps from block headers alone, must agree with the recorder's own ledger.
//
// Run:  node bench/stalled-consumer.ts [--stall 10] [--duration 30]

import fs from 'node:fs';
import { parseArgv } from '../src/util/cli.ts';
import { start, exitOf, sleep, validate, report } from './lib.ts';

const { opts } = parseArgv();
const STALL = Number(opts.stall ?? 10);
const DURATION = Number(opts.duration ?? 30);
const out = '/tmp/sigacq-bench-stall.sigb';
const sock = '/tmp/sigacq-bench-stall.sock';
const pacing = '/tmp/sigacq-bench-stall-pacing.json';
for (const f of [out, out.replace('.sigb', '.json'), sock, pacing]) fs.rmSync(f, { force: true });

console.log(`stalled consumer: ${DURATION} s run, recorder frozen for ${STALL} s\n`);
const rec = start('recorder', ['--out', out, '--socket', sock, '--quiet', '--stats-interval', '0']);
await sleep(700);
const gen = start('generator', ['--socket', sock, '--duration', String(DURATION), '--stats-interval', '1', '--pacing-out', pacing], 'pipe');
let latest: Record<string, number> = {};
gen.stderr!.on('data', (d: Buffer) => {
  for (const line of String(d).split('\n')) {
    try {
      const o = JSON.parse(line);
      if (o.event === 'stats') latest = o;
    } catch {
      // the config banner is not JSON
    }
  }
});

const pre = Math.floor((DURATION - STALL) / 2);
await sleep(pre * 1000);
console.log(`  t=${pre}s  deviation ${latest.deviationFrames} frames — SIGSTOP recorder`);
process.kill(rec.pid!, 'SIGSTOP');
const during: number[] = [];
for (let i = 1; i <= STALL; i++) {
  await sleep(1000);
  during.push(latest.deviationFrames);
  console.log(`    +${i}s  deviation ${String(latest.deviationFrames).padStart(3)} frames   ring ${String(latest.ringFillPct).padStart(6)}%   dropped ${latest.droppedFrames}`);
}
process.kill(rec.pid!, 'SIGCONT');
console.log('  SIGCONT');

await exitOf(gen);
await sleep(1500);
process.kill(rec.pid!, 'SIGINT');
await exitOf(rec);

const g = JSON.parse(fs.readFileSync(pacing, 'utf8'));
const sidecar = JSON.parse(fs.readFileSync(out.replace('.sigb', '.json'), 'utf8'));
const v = validate(out);
const tick = g.framesPerTick;
console.log(`\n  generator: deviation ${g.deviationFrames} frames, ${g.resyncCount} resyncs, ${g.drops.totalDroppedFrames} frames dropped in ${g.drops.entries.length} range(s)`);
console.log(`  validator: missing ${v.missing}, incorrect ${v.incorrect}; recorder ledger ${sidecar.drops.totalDroppedValues} values`);

report([
  ['generator never fell behind (within one tick)', Math.abs(g.deviationFrames) <= tick],
  ['deviation stayed within one tick throughout the stall', during.every((d) => Math.abs(d) <= tick)],
  ['no pacing resync was needed', g.resyncCount === 0],
  ['every dropped range has a start position', g.drops.entries.every((e: { startFrameIndex: number }) => Number.isInteger(e.startFrameIndex))],
  ['no delivered value was incorrect', v.incorrect === 0],
  ['no value was duplicated', v.duplicated === 0],
  ['validator and recorder ledger agree on what is missing', v.missing === sidecar.drops.totalDroppedValues],
]);
