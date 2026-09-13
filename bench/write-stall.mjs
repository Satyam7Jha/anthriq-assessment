// Fault F7 — slow disk. The case the external review reproduced and the original submission never ran.
//
// Every disk write is held back by --inject-write-stall-ms, which from the recorder's point of view
// is a saturated or failing device. Two scenarios:
//
//   SEVERE    1,500 ms per 512 KB write into a 1 MiB ring. Throughput collapses to ~1/3 of the input
//             rate, the ring overflows, and the recorder must drop. Before the F-01 fix this run
//             produced a CRC-clean file whose frame indices were silently wrong after the first drop:
//             validator "missing 0, incorrect 1,021,440". Now it must report the loss as MISSING, by
//             position, with zero incorrect values and a ledger that agrees with the derived gaps.
//
//   ABSORBED  200 ms per write into the default 64 MiB ring. Writes still keep up on average, so the
//             bounded ring must absorb it completely: zero loss, PASS.
//
// Run:  node bench/write-stall.mjs

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scenario({ name, stallMs, ringBytes, seconds }) {
  const out = `/tmp/bench-stall-${name}.sigb`;
  const sock = `/tmp/bench-stall-${name}.sock`;
  for (const f of [out, out.replace('.sigb', '.json'), sock]) fs.rmSync(f, { force: true });

  const rec = spawn(
    'node',
    [`${root}/bin/recorder.js`, '--out', out, '--socket', sock, '--quiet', '--stats-interval', '0',
     '--ring-bytes', String(ringBytes), '--inject-write-stall-ms', String(stallMs)],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  let recErr = '';
  rec.stderr.on('data', (d) => (recErr += d));
  await sleep(700);

  const gen = spawn('node', [`${root}/bin/generator.js`, '--socket', sock, '--duration', String(seconds), '--quiet', '--stats-interval', '0'], {
    stdio: 'ignore',
  });
  await new Promise((r) => gen.on('exit', r));
  const t0 = Date.now();
  rec.kill('SIGINT');
  const recCode = await new Promise((r) => rec.on('exit', r));
  const shutdownMs = Date.now() - t0;

  let v;
  try {
    v = { ...JSON.parse(execFileSync('node', [`${root}/bin/sigval.js`, out, '--json'], { encoding: 'utf8' })), exitCode: 0 };
  } catch (e) {
    v = JSON.parse(e.stdout);
  }
  const sidecar = JSON.parse(fs.readFileSync(out.replace('.sigb', '.json'), 'utf8'));
  const causes = [...new Set(sidecar.drops.entries.map((e) => e.cause))].join(', ') || 'none';

  console.log(`\n  ${name} — ${stallMs} ms per write, ${(ringBytes / 1048576).toFixed(0)} MiB ring, ${seconds} s`);
  console.log(`    recorder exit ${recCode} after ${shutdownMs} ms · finalised ${sidecar.acquisition.finalised} · ledger ${sidecar.drops.entries.length} range(s): ${causes}`);
  console.log(`    validator  ${v.result} (exit ${v.exitCode})  recorded ${v.recordedValues.toLocaleString()}  missing ${v.missing.toLocaleString()}  incorrect ${v.incorrect.toLocaleString()}`);
  console.log(`    declared dropped ${String(v.declaredDroppedValues?.toLocaleString())} · ledger agrees with derived gaps: ${v.ledgerAgreesWithDerivedGaps}`);
  if (/watchdog/.test(recErr)) console.log(`    recorder stderr: ${recErr.trim().split('\n').slice(-1)[0]}`);
  return { v, sidecar, recCode };
}

const checks = [];
const check = (name, ok) => checks.push([name, ok]);

const severe = await scenario({ name: 'severe', stallMs: 1500, ringBytes: 1024 * 1024, seconds: 20 });
check('severe: the recorder finalised its file despite the stalled disk', severe.sidecar.acquisition.finalised === true);
check('severe: loss occurred (the fault really bit)', severe.v.missing > 0);
check('severe: ZERO incorrect values — no frame index was mislabelled (F-01)', severe.v.incorrect === 0);
check('severe: zero duplicated values', severe.v.duplicated === 0);
check('severe: the header ledger agrees with the validator\'s derived gaps', severe.v.ledgerAgreesWithDerivedGaps === true);
check('severe: verdict is FAIL with exit 1 — loss is never a PASS', severe.v.exitCode === 1);

const absorbed = await scenario({ name: 'absorbed', stallMs: 200, ringBytes: 64 * 1024 * 1024, seconds: 12 });
check('absorbed: the 64 MiB ring absorbs a 200 ms-per-write disk with zero loss', absorbed.v.missing === 0);
check('absorbed: PASS, exit 0', absorbed.v.exitCode === 0);

console.log('');
let bad = 0;
for (const [name, ok] of checks) {
  if (!ok) bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
}
fs.mkdirSync(`${root}/artifacts`, { recursive: true });
fs.writeFileSync(
  `${root}/artifacts/write-stall.json`,
  `${JSON.stringify({ severe: { validator: severe.v, drops: severe.sidecar.drops }, absorbed: { validator: absorbed.v }, checks }, null, 2)}\n`
);
console.log(`\n  ${bad === 0 ? 'ALL CHECKS PASSED' : `${bad} CHECK(S) FAILED`}   artifact: artifacts/write-stall.json`);
process.exit(bad === 0 ? 0 : 1);
