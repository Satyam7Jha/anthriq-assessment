#!/usr/bin/env node
'use strict';
// THE VALIDATOR. PLAN §10. Milestone 9 — the project's centre of gravity.
//
// Proves that the bytes on disk equal value(c, n) for every (c, n) the file claims to contain, and
// that the set of n present is exactly [0, totalFrames) — no gaps, no repeats.
//
// STREAMING, O(1) MEMORY (R41). Resident working set: one block buffer (512,064 B, reused), one
// 64-byte header buffer, a 4-byte scratch, ~14 counters and 3 first-discrepancy slots. Neither the
// recording nor the expected signal is ever materialised — the expected signal is RECOMPUTED ONE
// VALUE AT A TIME from a closed-form function, which is precisely why §5's statelessness
// requirement matters for the validator and not just for the generator.
//
// Exit codes are the machine-checkable result (R43):
//   0  PASS                 complete, finalised, zero discrepancies
//   1  FAIL                 missing / duplicated / incorrect / corrupt
//   2  PASS (TRUNCATED)     all present data correct, but the file is not finalised
//   3  UNREADABLE           bad magic/CRC/version, or an unknown signalId
//  64  usage error

const fs = require('node:fs');
const { parseArgv } = require('../src/util/cli');
const { createSignal } = require('../src/signal/signal');
const fileHeader = require('../src/format/file-header');
const blockHeader = require('../src/format/block-header');
const { crc32c } = require('../src/format/crc32c');
const { openRecording, readLedger, blockOffset } = require('../src/store/recover');
const { SIGNAL_ID } = require('../src/config/defaults');
const { n } = require('../src/util/fmt');

const EXIT = { PASS: 0, FAIL: 1, TRUNCATED: 2, UNREADABLE: 3, USAGE: 64 };

const USAGE = `
sigval — validate a recording against the deterministic expected signal

  node bin/sigval.js FILE.sigb [options]

  --json           emit a single JSON object instead of the human format
  --no-crc         skip per-block CRC verification (~2x faster; weakens the
                   "corrupt vs incorrect" distinction — see PLAN §10.2)
  --max-report N   detail lines per discrepancy class (default 10)
  --quiet          result lines only
  --help

exit: 0 PASS  1 FAIL  2 PASS(TRUNCATED)  3 UNREADABLE  64 usage
`;

function main() {
  const { opts, positional } = parseArgv(process.argv.slice(2), {
    booleans: ['json', 'crc', 'quiet', 'help'],
  });
  if (opts.help) {
    process.stdout.write(USAGE);
    return EXIT.PASS;
  }
  const file = positional[0];
  if (!file) {
    process.stderr.write(`error: no file given\n${USAGE}`);
    return EXIT.USAGE;
  }
  const checkCrc = opts.crc !== false;
  const maxReport = Number(opts.maxReport ?? 10);

  let rec;
  try {
    rec = openRecording(file);
  } catch (e) {
    process.stderr.write(`UNREADABLE: ${e.message}\n`);
    return EXIT.UNREADABLE;
  }

  const { fd, hdr, extent, fileSize } = rec;
  try {
    // Refuse to validate a signal we cannot reproduce. Silently validating an unknown formula
    // would be worse than refusing: it would report every value as incorrect.
    if (hdr.signalId !== SIGNAL_ID) {
      process.stderr.write(
        `UNREADABLE: file declares signalId ${JSON.stringify(hdr.signalId)}, this validator ` +
          `knows only ${JSON.stringify(SIGNAL_ID)}\n`
      );
      return EXIT.UNREADABLE;
    }
    if (hdr.dtypeCode !== 1) {
      process.stderr.write(`UNREADABLE: dtypeCode ${hdr.dtypeCode} is not float32LE\n`);
      return EXIT.UNREADABLE;
    }

    const C = hdr.channelCount;
    const signal = createSignal({ channelCount: C, dither: !hdr.ditherDisabled });

    // --- the only buffers this program holds, both reused for every block ---
    const blockBuf = Buffer.allocUnsafeSlow(hdr.blockStrideBytes);
    const payloadF32 = new Float32Array(blockBuf.buffer, blockBuf.byteOffset + hdr.blockHeaderBytes,
      (hdr.blockStrideBytes - hdr.blockHeaderBytes) / 4);
    const payloadU32 = new Uint32Array(blockBuf.buffer, blockBuf.byteOffset + hdr.blockHeaderBytes,
      (hdr.blockStrideBytes - hdr.blockHeaderBytes) / 4);
    // Comparison is on BIT PATTERNS, not ===. That sidesteps the two ways === misleads on floats:
    // NaN !== NaN would under-report, and -0 === +0 would over-accept.
    const scratch = new Float32Array(1);
    const scratchU32 = new Uint32Array(scratch.buffer);

    let missing = 0;
    let duplicated = 0;
    let incorrect = 0;
    let corruptValues = 0;
    let recordedValues = 0;
    let blocksRead = 0;
    let expectedNext = 0;
    let truncatedAtByte = null;
    const first = { missing: null, duplicated: null, incorrect: null, corrupt: null };
    const detail = { missing: [], duplicated: [], incorrect: [], corrupt: [] };

    const note = (cls, obj) => {
      if (first[cls] === null) first[cls] = obj;
      if (detail[cls].length < maxReport) detail[cls].push(obj);
    };

    const t0 = process.hrtime.bigint();

    for (let b = 0; b < extent.blockCount; b++) {
      const off = blockOffset(hdr, b);
      const got = fs.readSync(fd, blockBuf, 0, hdr.blockStrideBytes, off);
      if (got < hdr.blockHeaderBytes) {
        truncatedAtByte = off;
        break;
      }
      const bh = blockHeader.decode(blockBuf, 0);
      if (!bh.magicOk || !bh.headerCrcOk) {
        // A block whose own header is unreadable: treat its nominal span as corrupt rather than
        // guessing at its contents.
        corruptValues += hdr.framesPerBlock * C;
        note('corrupt', { blockIndex: b, byteOffset: off, reason: bh.magicOk ? 'header-crc' : 'magic' });
        expectedNext += hdr.framesPerBlock;
        continue;
      }
      if (got < hdr.blockHeaderBytes + bh.payloadBytes) {
        truncatedAtByte = off + got;
        break;
      }
      blocksRead++;

      // --- sequence classification: the same three-line rule the recorder uses (PLAN §4.4) ---
      if (bh.startFrameIndex > expectedNext) {
        const gapFrames = bh.startFrameIndex - expectedNext;
        missing += gapFrames * C;
        note('missing', {
          valueIndex: expectedNext * C,
          frameIndex: expectedNext,
          frameCount: gapFrames,
          valueCount: gapFrames * C,
          timeSeconds: expectedNext / hdr.sampleRateExactHz,
          blockIndex: b,
        });
        expectedNext = bh.startFrameIndex;
      } else if (bh.startFrameIndex < expectedNext) {
        const overlapFrames = Math.min(expectedNext - bh.startFrameIndex, bh.frameCount);
        duplicated += overlapFrames * C;
        note('duplicated', {
          valueIndex: bh.startFrameIndex * C,
          frameIndex: bh.startFrameIndex,
          frameCount: overlapFrames,
          valueCount: overlapFrames * C,
          timeSeconds: bh.startFrameIndex / hdr.sampleRateExactHz,
          blockIndex: b,
        });
      }

      if (checkCrc) {
        const actual = crc32c(blockBuf, hdr.blockHeaderBytes, hdr.blockHeaderBytes + bh.payloadBytes);
        if (actual !== bh.payloadCrc32c) {
          // Reported as its OWN class, beyond what the assessment asks for. Without it a bit-rotted
          // block would be reported as 128,000 "incorrect values" — technically true and
          // diagnostically useless.
          corruptValues += bh.frameCount * C;
          note('corrupt', {
            blockIndex: b,
            byteOffset: off,
            frameIndex: bh.startFrameIndex,
            expectedCrc: bh.payloadCrc32c,
            actualCrc: actual,
          });
          recordedValues += bh.frameCount * C;
          expectedNext = Math.max(expectedNext, bh.startFrameIndex + bh.frameCount);
          continue;
        }
      }

      // --- value comparison, planar within the block ---
      for (let c = 0; c < C; c++) {
        const base = c * bh.frameCount;
        for (let j = 0; j < bh.frameCount; j++) {
          scratch[0] = signal.value(c, bh.startFrameIndex + j); // narrows exactly as the generator did
          if (scratchU32[0] !== payloadU32[base + j]) {
            incorrect++;
            if (detail.incorrect.length < maxReport || first.incorrect === null) {
              const frameIndex = bh.startFrameIndex + j;
              note('incorrect', {
                valueIndex: frameIndex * C + c,
                channel: c,
                frameIndex,
                timeSeconds: frameIndex / hdr.sampleRateExactHz,
                expected: scratch[0],
                actual: payloadF32[base + j],
                blockIndex: b,
                byteOffset: off + hdr.blockHeaderBytes + (base + j) * 4,
              });
            }
          }
        }
      }

      recordedValues += bh.frameCount * C;
      expectedNext = Math.max(expectedNext, bh.startFrameIndex + bh.frameCount);
    }

    const elapsedSeconds = Number(process.hrtime.bigint() - t0) / 1e9;

    // `Expected` is the header's claim when FINALISED, else the recovered extent. `Missing` is
    // derived from SEQUENCE GAPS, not from Expected - Recorded: those two can legitimately
    // disagree (duplicates inflate Recorded), and reporting both makes the discrepancy itself a
    // signal rather than hiding it.
    const expectedValues = hdr.finalised && !extent.recovered ? hdr.totalValues : extent.totalValues;
    const ledger = readLedger(fd, hdr, fileSize);

    const failed = missing > 0 || duplicated > 0 || incorrect > 0 || corruptValues > 0;
    const truncated = !hdr.finalised || extent.recovered || truncatedAtByte !== null;
    const result = failed ? 'FAIL' : truncated ? 'PASS (TRUNCATED)' : 'PASS';
    const code = failed ? EXIT.FAIL : truncated ? EXIT.TRUNCATED : EXIT.PASS;

    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            file,
            result,
            exitCode: code,
            expectedValues,
            recordedValues,
            missing,
            duplicated,
            incorrect,
            corrupt: corruptValues,
            finalised: hdr.finalised,
            recovered: extent.recovered,
            truncatedAtByte,
            blocksRead,
            blockCount: extent.blockCount,
            firstDiscrepancy: first,
            detail,
            recorderLedger: ledger.entries,
            crcChecked: checkCrc,
            elapsedSeconds: +elapsedSeconds.toFixed(3),
            throughputValuesPerSecond: Math.round(recordedValues / elapsedSeconds),
            peakRssBytes: process.memoryUsage.rss(),
          },
          null,
          2
        )}\n`
      );
      return code;
    }

    // The six lines below match the assessment's representative output EXACTLY — label spelling,
    // order, alignment and thousands separators. They are printed FIRST even on failure, so any
    // script parsing them keeps working. test/fixtures/expected-pass.txt pins this byte-for-byte.
    const out = [
      `Expected: ${n(expectedValues)} samples`,
      `Recorded: ${n(recordedValues)} samples`,
      `Missing:   ${n(missing)}`,
      `Duplicated: ${n(duplicated)}`,
      `Incorrect:  ${n(incorrect)}`,
      `Result: ${result}`,
    ];
    if (corruptValues > 0) out.push(`Corrupt:    ${n(corruptValues)}   (CRC-failed blocks, counted separately)`);
    process.stdout.write(`${out.join('\n')}\n`);

    if (!opts.quiet && (failed || truncated)) {
      const lines = [''];
      const pos = (o) =>
        `value #${n(o.valueIndex)}  (channel ${o.channel ?? 0}, frame ${n(o.frameIndex)}, t=${o.timeSeconds.toFixed(6)}s)`;
      if (first.missing) {
        lines.push(`First missing:    ${pos(first.missing)}`);
        lines.push(`                  ${n(first.missing.valueCount)} values, block #${first.missing.blockIndex}`);
      }
      if (first.duplicated) lines.push(`First duplicated: ${pos(first.duplicated)}`);
      if (first.incorrect) {
        lines.push(`First incorrect:  ${pos(first.incorrect)}`);
        lines.push(
          `                  expected ${first.incorrect.expected}, got ${first.incorrect.actual}, ` +
            `byte offset ${n(first.incorrect.byteOffset)}`
        );
      }
      if (first.corrupt) {
        lines.push(`First corrupt:    block #${first.corrupt.blockIndex} at byte ${n(first.corrupt.byteOffset)}`);
      }
      if (truncated) {
        lines.push(
          `Truncation:       file is ${hdr.finalised ? 'finalised but short' : 'NOT finalised'}; ` +
            `recovered ${n(extent.blockCount)} whole blocks, ` +
            `${n(extent.truncatedTailBytes ?? 0)} trailing bytes ignored`
        );
      }
      // The independent cross-check: the recorder's OWN ledger versus the gaps this validator
      // derived from block headers alone. Two independent derivations of the same fact.
      if (ledger.entries.length || missing > 0) {
        const ledgerFrames = ledger.entries.reduce((a, e) => a + e.frameCount, 0);
        const agree = ledgerFrames * C === missing;
        lines.push(
          `Drop ledger:      ${ledger.entries.length} entr${ledger.entries.length === 1 ? 'y' : 'ies'}, ` +
            `${n(ledgerFrames * C)} values (source: ${ledger.source}) — ` +
            `${agree ? 'AGREES with independently derived gaps' : 'DISAGREES with derived gaps'}`
        );
      }
      lines.push('');
      process.stderr.write(lines.join('\n'));
    }

    if (!opts.quiet) {
      process.stderr.write(
        `validated ${n(recordedValues)} values in ${elapsedSeconds.toFixed(2)} s ` +
          `(${n(Math.round(recordedValues / elapsedSeconds))} values/s), ` +
          `peak RSS ${(process.memoryUsage.rss() / 1048576).toFixed(1)} MiB, CRC ${checkCrc ? 'on' : 'off'}\n`
      );
    }
    return code;
  } finally {
    rec.close();
  }
}

process.exitCode = main();
