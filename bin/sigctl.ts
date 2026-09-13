#!/usr/bin/env node
// Inspection and retrieval. Logic: src/inspect/. Opens files read-only.

import { parseArgv } from '../src/util/cli.ts';
import { openRecording } from '../src/store/recover.ts';
import { info } from '../src/inspect/info.ts';
import { read } from '../src/inspect/read.ts';
import { seek, hexdump } from '../src/inspect/seek.ts';
import { play } from '../src/inspect/play.ts';

const USAGE = `
sigctl — inspect and retrieve from a .sigb recording

  node bin/sigctl.ts info FILE [--json]
  node bin/sigctl.ts read FILE [--from T] [--to T] [--channels LIST] [--out csv|jsonl|raw|none]
  node bin/sigctl.ts seek FILE [--at T,T,...] [--json]
  node bin/sigctl.ts play FILE [--from T] [--to T] [--channels LIST] [--speed X] [--out raw|none] [--stats-interval S]
  node bin/sigctl.ts hexdump FILE

  T         "12.5s" | "#50000" (frame index) | "1:30" | "250ms"
  LIST      "3,17" | "0-7" | "all" | "even"
  play      stdout: interleaved float32le frames, paced at native rate × speed (0.05–16)
            stdin:  keys on a terminal, else lines — pause · resume · seek T · speed X · quit

exit: 0 ok · 3 unreadable · 64 usage
`;

async function main(): Promise<number> {
  const { opts, positional } = parseArgv(process.argv.slice(2), { booleans: ['json', 'help'] });
  const [cmd, file] = positional;
  if (opts.help || !cmd || !file) {
    process.stdout.write(USAGE);
    return opts.help ? 0 : 64;
  }
  let rec;
  try {
    rec = openRecording(file);
  } catch (e) {
    process.stderr.write(`UNREADABLE: ${(e as Error).message}\n`);
    return 3;
  }
  try {
    switch (cmd) {
      case 'info':
        return info(rec, { json: !!opts.json });
      case 'read':
        return read(rec, opts);
      case 'seek':
        return seek(rec, opts);
      case 'play':
        return await play(rec, opts);
      case 'hexdump':
        return hexdump(rec);
      default:
        process.stderr.write(`unknown subcommand ${JSON.stringify(cmd)}\n${USAGE}`);
        return 64;
    }
  } finally {
    rec.close();
  }
}

process.exitCode = await main();
