#!/usr/bin/env node
// The validator. Logic: src/verify/.
// Exit: 0 PASS · 1 FAIL · 2 PASS (TRUNCATED) · 3 UNREADABLE · 64 usage

import { parseArgv } from '../src/util/cli.ts';
import { openRecording } from '../src/store/recover.ts';
import { validate, EXIT } from '../src/verify/validate.ts';
import { resultLines, detailLines, summaryLine } from '../src/verify/print.ts';

const USAGE = `
sigval — validate a recording against the deterministic expected signal

  node bin/sigval.ts FILE.sigb [--json] [--no-crc] [--quiet]

exit: 0 PASS  1 FAIL  2 PASS(TRUNCATED)  3 UNREADABLE  64 usage
`;

function main(): number {
  const { opts, positional } = parseArgv(process.argv.slice(2), { booleans: ['json', 'crc', 'quiet', 'help'] });
  if (opts.help || !positional[0]) {
    process.stdout.write(USAGE);
    return opts.help ? EXIT.PASS : EXIT.USAGE;
  }
  let rec;
  try {
    rec = openRecording(positional[0]);
  } catch (e) {
    process.stderr.write(`UNREADABLE: ${(e as Error).message}\n`);
    return EXIT.UNREADABLE;
  }
  try {
    const r = validate(rec, { checkCrc: opts.crc !== false });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      return r.exitCode;
    }
    process.stdout.write(resultLines(r));
    if (!opts.quiet) {
      if (r.exitCode !== EXIT.PASS) process.stderr.write(detailLines(r));
      process.stderr.write(summaryLine(r));
    }
    return r.exitCode;
  } catch (e) {
    process.stderr.write(`UNREADABLE: ${(e as Error).message}\n`);
    return EXIT.UNREADABLE;
  } finally {
    rec.close();
  }
}

process.exitCode = main();
