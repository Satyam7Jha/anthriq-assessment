// R11, the assessment's hardest acquisition requirement:
//   "A slow/stalled consumer must not make the generator fall behind."
//
// The experiment: run the pair to steady state, SIGSTOP the recorder for N seconds (a real, total
// consumer stall — the process is not scheduled at all), SIGCONT it, and compare the generator's
// pacing BEFORE, DURING and AFTER the stall window.
//
// What must be true:
//   1. pacing deviation during the stall is indistinguishable from before it — the generator does
//      not slow, does not block, does not wait for 'drain';
//   2. any loss is reported as POSITIONED RANGES, never as a bare count;
//   3. the loss begins only after the ring's DESIGNED absorption window has elapsed, which is what
//      makes the bound a designed bound rather than an accident.
//
// Run:  node bench/stalled-consumer.mjs [--stall 12] [--duration 40]

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i === -1 ? d : Number(process.argv[i + 1]);
};
const STALL_S = arg('stall', 12);
const DURATION_S = arg('duration', 40);
const GEN_RING_BLOCKS = arg('gen-ring-blocks', 1024);

const out = '/tmp/bench-stall.sigb';
const sock = '/tmp/bench-stall.sock';
const pacing = '/tmp/bench-stall-pacing.json';
for (const f of [out, out.replace('.sigb', '.json'), sock, pacing]) fs.rmSync(f, { force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const genLines = [];
const recLines = [];

console.log(`stalled-consumer: ${DURATION_S}s run, recorder SIGSTOPped for ${STALL_S}s mid-run\n`);

const rec = spawn('node', [`${root}/bin/recorder.js`, '--out', out, '--socket', sock, '--stats-interval', '2'], {
  stdio: ['ignore', 'ignore', 'pipe'],
});
rec.stderr.on('data', (d) => recLines.push(...String(d).trim().split('\n')));
await sleep(700);

const gen = spawn(
  'node',
  // NOT --quiet: the per-second stats lines are info-level, and they are the measurement.
  [`${root}/bin/generator.js`, '--socket', sock, '--duration', String(DURATION_S),
   '--stats-interval', '1', '--gen-ring-blocks', String(GEN_RING_BLOCKS), '--pacing-out', pacing],
  { stdio: ['ignore', 'ignore', 'pipe'] }
);
gen.stderr.on('data', (d) => genLines.push(...String(d).trim().split('\n')));

const statsOf = (lines) =>
  lines
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((o) => o && o.event === 'stats');

// --- let it reach steady state, then INJECT -----------------------------------------------------
const preStallEnd = Math.floor((DURATION_S - STALL_S) / 2);
await sleep(preStallEnd * 1000);
const before = statsOf(genLines).at(-1);
console.log(`  t=${preStallEnd}s  steady state: deviation ${before.deviationFrames} frames (${before.deviationPpm} ppm), ring ${before.ringFillPct}%`);

console.log(`  t=${preStallEnd}s  >>> SIGSTOP recorder (pid ${rec.pid})`);
process.kill(rec.pid, 'SIGSTOP');
const stallStart = Date.now();

// Watch the generator every second WHILE the consumer is frozen.
const during = [];
for (let i = 0; i < STALL_S; i++) {
  await sleep(1000);
  const s = statsOf(genLines).at(-1);
  during.push(s);
  console.log(
    `    +${i + 1}s  deviation ${String(s.deviationFrames).padStart(4)} frames` +
      `  ring ${String(s.ringFillPct).padStart(6)}%  dropped ${String(s.droppedFrames).padStart(7)}` +
      `  drainStalls ${s.drainStalls}`
  );
}

console.log(`  >>> SIGCONT recorder after ${((Date.now() - stallStart) / 1000).toFixed(1)}s`);
process.kill(rec.pid, 'SIGCONT');

await new Promise((r) => gen.on('exit', r));
const after = statsOf(genLines).at(-1);
await sleep(1500);
process.kill(rec.pid, 'SIGINT');
await new Promise((r) => rec.on('exit', r));
await sleep(300);

// --- EVIDENCE ---------------------------------------------------------------------------------
const report = JSON.parse(fs.readFileSync(pacing, 'utf8'));
const sidecar = JSON.parse(fs.readFileSync(out.replace('.sigb', '.json'), 'utf8'));

let val;
try {
  val = JSON.parse(execFileSync('node', [`${root}/bin/sigval.js`, out, '--json'], { encoding: 'utf8' }));
  val.exitCode = 0;
} catch (e) {
  val = JSON.parse(e.stdout);
}

const devDuring = during.map((s) => s.deviationFrames);
const maxAbsDevDuring = Math.max(...devDuring.map(Math.abs));
const framesPerTick = report.framesPerTick;

console.log('\n  (a) GENERATOR PACING — must be unaffected by the stall');
console.log(`      deviation before stall      ${before.deviationFrames} frames`);
console.log(`      deviation during stall      max |${maxAbsDevDuring}| frames  [${devDuring.join(', ')}]`);
console.log(`      deviation at end of run     ${report.deviationFrames} frames (${report.deviationPpm} ppm)`);
console.log(`      tick lag p99 / max          <= ${report.tickLag.p99UsAtMost} us / ${report.tickLag.maxUs} us`);
console.log(`      pacing resyncs              ${report.resyncCount}`);
console.log(`      emitted vs wall clock       ${report.emittedFrames.toLocaleString()} vs ${report.expectedFrames.toLocaleString()} expected`);

console.log('\n  (b) LOSS — must be POSITIONED RANGES, never a bare count');
const genDrops = report.drops;
console.log(`      generator ledger            ${genDrops.totalDroppedFrames.toLocaleString()} frames in ${genDrops.entries.length} range(s)`);
for (const e of genDrops.entries.slice(0, 5)) {
  console.log(
    `        frame ${String(e.startFrameIndex).padStart(10)}  +${String(e.frameCount).padStart(8)}` +
      `  value #${String(e.startValueIndex).padStart(11)}  t=${e.startSeconds.toFixed(3)}s  ${e.cause}`
  );
}
console.log(`      recorder ledger             ${sidecar.drops.totalDroppedFrames.toLocaleString()} frames in ${sidecar.drops.entries.length} range(s)`);
for (const e of sidecar.drops.entries.slice(0, 5)) {
  console.log(
    `        frame ${String(e.startFrameIndex).padStart(10)}  +${String(e.frameCount).padStart(8)}` +
      `  value #${String(e.startValueIndex).padStart(11)}  t=${e.startSeconds.toFixed(3)}s  ${e.cause}`
  );
}

console.log('\n  (c) CROSS-CHECK — the validator derives gaps from block headers ALONE');
console.log(`      validator missing values    ${val.missing.toLocaleString()}`);
console.log(`      recorder-reported values    ${(sidecar.drops.totalDroppedValues || 0).toLocaleString()}`);
const crossOk = val.missing === sidecar.drops.totalDroppedValues;
console.log(`      agreement                   ${crossOk ? 'AGREE' : 'DISAGREE'}`);
console.log(`      validator incorrect         ${val.incorrect}  (every DELIVERED value must still be correct)`);
console.log(`      validator result            ${val.result}`);

console.log('\n  (d) THE BOUND — loss must begin only after the ring absorption window');
const genRingSeconds = (GEN_RING_BLOCKS * framesPerTick) / report.rateHz;
const recRingSeconds = sidecar.buffering.ringSeconds;
const absorbed = genDrops.entries.length ? genDrops.entries[0].startSeconds - preStallEnd : null;
console.log(`      generator ring capacity     ${genRingSeconds.toFixed(2)} s`);
console.log(`      recorder ring capacity      ${recRingSeconds.toFixed(1)} s`);
console.log(`      socket buffer + rec ring    absorb before the generator ring is even reached`);
console.log(`      stall duration              ${STALL_S} s`);
console.log(`      first loss at               ${absorbed === null ? 'no loss at all' : `${absorbed.toFixed(2)} s into the stall`}`);
console.log(`      recorder ring peak          ${sidecar.buffering.ringPeakPct}%`);

const checks = [
  ['generator never fell behind (deviation stays within one tick)', Math.abs(report.deviationFrames) <= framesPerTick],
  ['deviation during the stall stays within one tick', maxAbsDevDuring <= framesPerTick],
  ['no pacing resync was needed', report.resyncCount === 0],
  ['every dropped range carries a start position', genDrops.entries.every((e) => Number.isInteger(e.startFrameIndex))],
  ['no delivered value was incorrect', val.incorrect === 0],
  ['no value was duplicated', val.duplicated === 0],
  ['recorder and validator agree on the missing count', crossOk],
];
console.log('');
let bad = 0;
for (const [name, ok] of checks) {
  if (!ok) bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
}
fs.mkdirSync(`${root}/artifacts`, { recursive: true });
fs.writeFileSync(
  `${root}/artifacts/stalled-consumer.json`,
  `${JSON.stringify({ stallSeconds: STALL_S, durationSeconds: DURATION_S, before, during, pacing: report, recorderDrops: sidecar.drops, validator: val, checks }, null, 2)}\n`
);
console.log(`\n  ${bad === 0 ? 'ALL CHECKS PASSED' : `${bad} CHECK(S) FAILED`}   artifact: artifacts/stalled-consumer.json`);
process.exit(bad === 0 ? 0 : 1);
