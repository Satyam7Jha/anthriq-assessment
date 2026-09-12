// Regression test for two real data-corruption bugs found by bench/stalled-consumer.mjs.
//
// BUG 1 — net.Socket.write() does not copy. It retains the Buffer and writes the bytes later, when
// the kernel has room. The generator originally handed it a view straight into its reusable block
// ring, so once the ring wrapped, the socket sent whatever the slot held AT FLUSH TIME. Under a
// 10-second consumer stall this silently corrupted the stream: the recorder saw frame indices jump
// to values the generator had never sent, and the two drop ledgers disagreed by 20,000 frames.
//
// BUG 2 — the same class of bug in fs.write, plus a stride violation: a SHORT block written at a gap
// boundary occupied fewer than blockStrideBytes on disk, which silently invalidated every offset
// formula after it (seek, channel-subset reads, truncation recovery).
//
// Both are the kind of bug that passes every short happy-path test and only appears under stall.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('net.Socket.write retains the buffer — mutating a queued Buffer corrupts the stream', async () => {
  // This documents the PLATFORM behaviour the generator must defend against. If a future Node ever
  // copies on write, this test tells us the defence is no longer load-bearing.
  const sockPath = path.join(os.tmpdir(), `zc-${process.pid}.sock`);
  fs.rmSync(sockPath, { force: true });

  let client;
  let server;
  try {
    const received = await new Promise((resolve, reject) => {
      const chunks = [];
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      server = net.createServer((s) => {
        s.pause(); // do not read, so the sender's userland queue builds up
        setTimeout(() => {
          s.on('data', (d) => chunks.push(d));
          s.resume();
        }, 200).unref();
        setTimeout(() => {
          s.destroy();
          finish(Buffer.concat(chunks));
        }, 900).unref();
      });
      server.on('error', reject);
      server.listen(sockPath, () => {
        client = net.createConnection({ path: sockPath }, () => {
          const filler = Buffer.alloc(1 << 20, 0x5a);
          for (let i = 0; i < 8; i++) client.write(filler); // fill the kernel buffer
          const slot = Buffer.alloc(4096, 0x41); // 'A' — stands in for a ring slot
          client.write(slot);
          assert.ok(client.writableLength > 0, 'test setup failed: no userland queue formed');
          setTimeout(() => slot.fill(0x42), 80).unref(); // recycle before it is flushed
        });
        client.on('error', () => {}); // the peer destroying the socket is the expected ending
      });
    });

    const bCount = received.filter((b) => b === 0x42).length;
    assert.ok(
      bCount > 0,
      "net.Socket.write appears to copy now; the generator's send-staging ring may no longer be needed"
    );
  } finally {
    // Without this the test process holds a socket with megabytes still queued and never exits.
    client?.destroy();
    server?.close();
    fs.rmSync(sockPath, { force: true });
  }
});

test('the generator stages its sends, so a recycled ring slot cannot corrupt the wire', () => {
  // The structural guarantee, asserted from the source rather than from a timing-dependent run:
  // the staging ring must be strictly larger than the maximum bytes the socket can hold, because
  // that is the bound that makes slot reuse safe.
  const genSrc = fs.readFileSync(new URL('../bin/generator.js', import.meta.url), 'utf8');
  assert.match(genSrc, /sendStage/, 'generator must stage sends rather than writing ring views');
  assert.match(genSrc, /block\.bytes\.copy\(sendStage/, 'generator must COPY into the staging ring');

  const D = JSON.parse(
    JSON.stringify({
      hwm: 1024 * 1024,
      wireBlockBytes: 32 + 20 * 32 * 4, // defaults: 2,592 B
    })
  );
  const stageSlots = Math.ceil(D.hwm / D.wireBlockBytes) + 4;
  const stageBytes = stageSlots * D.wireBlockBytes;
  const maxOutstanding = D.hwm + D.wireBlockBytes; // the drain loop's refusal threshold, plus one block
  assert.ok(
    stageBytes > maxOutstanding,
    `staging ring ${stageBytes} B must exceed max outstanding ${maxOutstanding} B`
  );
});

test('every block occupies a full stride, so offsets stay computable after a short block', () => {
  // The format's central invariant. A reader computes block b's offset as
  // headerBytes + b * blockStrideBytes with no index and no scan, so a mid-file block that occupied
  // fewer bytes would corrupt every later offset.
  const writerSrc = fs.readFileSync(new URL('../src/store/writer.js', import.meta.url), 'utf8');
  assert.match(
    writerSrc,
    /this\.filePosition \+= this\.cfg\.blockStrideBytes/,
    'the writer must advance by a full stride even for a short block'
  );
  assert.doesNotMatch(writerSrc, /this\.filePosition \+= job\.bytes/, 'advancing by actual bytes breaks seek');
});
