// Fault F7 — a slow disk, via --inject-write-stall-ms.
//
//   SEVERE    1,500 ms per write into a 1 MiB ring: the ring overflows and the recorder must drop.
//             Before the F-01 fix this produced a CRC-clean file with silently wrong frame indices
//             ("0 missing, 1,021,440 incorrect"). Loss must now be MISSING, by position, 0 incorrect.
//   ABSORBED  200 ms per write into the default 64 MiB ring: writes keep up on average, so the
//             bounded ring must absorb it completely.
//
// Run:  node bench/write-stall.ts

import fs from 'node:fs';
import { start, exitOf, sleep, validate, report } from './lib.ts';

async function scenario(name: string, stallMs: number, ringBytes: number, seconds: number) {
  const out = `/tmp/sigacq-bench-${name}.sigb`;
  const sock = `/tmp/sigacq-bench-${name}.sock`;
  for (const f of [out, out.replace('.sigb', '.json'), sock]) fs.rmSync(f, { force: true });
  const rec = start('recorder', ['--out', out, '--socket', sock, '--quiet', '--stats-interval', '0', '--ring-bytes', String(ringBytes), '--inject-write-stall-ms', String(stallMs)]);
  await sleep(700);
  await exitOf(start('generator', ['--socket', sock, '--duration', String(seconds), '--quiet', '--stats-interval', '0']));
  rec.kill('SIGINT');
  await exitOf(rec);
  const v = validate(out);
  const finalised = JSON.parse(fs.readFileSync(out.replace('.sigb', '.json'), 'utf8')).acquisition.finalised === true;
  console.log(`  ${name.padEnd(9)} ${stallMs} ms/write, ${ringBytes / 1048576} MiB ring: ${v.result} (exit ${v.exitCode}) · missing ${v.missing.toLocaleString()} · incorrect ${v.incorrect} · ledger agrees: ${v.ledgerAgreesWithDerivedGaps}`);
  return { v, finalised };
}

const severe = await scenario('severe', 1500, 1024 * 1024, 20);
const absorbed = await scenario('absorbed', 200, 64 * 1024 * 1024, 12);

report([
  ['severe: the recorder finalised its file despite the stalled disk', severe.finalised],
  ['severe: loss occurred (the fault really bit)', severe.v.missing > 0],
  ['severe: zero incorrect values — no frame index was mislabelled', severe.v.incorrect === 0],
  ['severe: the header ledger agrees with the derived gaps', severe.v.ledgerAgreesWithDerivedGaps === true],
  ['severe: FAIL, exit 1 — loss is never a pass', severe.v.exitCode === 1],
  ['absorbed: zero loss, PASS', absorbed.v.missing === 0 && absorbed.v.exitCode === 0],
]);
