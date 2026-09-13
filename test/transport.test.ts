// Two data-corruption bugs found under stall, and the defences against them.
//
//   1. net.Socket.write() does not copy the Buffer it is given. A view into a reusable ring sent
//      whatever the slot held at flush time. Defence: the generator's send-staging ring.
//   2. A short block that occupied less than a full stride invalidated every later offset.
//      Defence: every block advances the file position by blockStrideBytes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stagingSlots } from '../src/generator/sender.ts';
import { DEFAULTS as D } from '../src/config/defaults.ts';

test('platform: net.Socket.write retains the buffer, so mutating it corrupts the stream', async () => {
  // If a future Node copies on write, this fails and says the staging ring is no longer load-bearing.
  const sockPath = path.join(os.tmpdir(), `sigacq-zc-${process.pid}.sock`);
  fs.rmSync(sockPath, { force: true });
  let client: net.Socket | undefined;
  let server: net.Server | undefined;
  try {
    const received = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      server = net.createServer((s) => {
        s.pause(); // do not read, so the sender's userland queue builds up
        setTimeout(() => (s.on('data', (d: Buffer) => chunks.push(d)), s.resume()), 200).unref();
        setTimeout(() => (s.destroy(), resolve(Buffer.concat(chunks))), 900).unref();
      });
      server.on('error', reject);
      server.listen(sockPath, () => {
        client = net.createConnection({ path: sockPath }, () => {
          for (let i = 0; i < 8; i++) client!.write(Buffer.alloc(1 << 20, 0x5a)); // fill the kernel buffer
          const slot = Buffer.alloc(4096, 0x41);
          client!.write(slot);
          assert.ok(client!.writableLength > 0, 'setup failed: no userland queue formed');
          setTimeout(() => slot.fill(0x42), 80).unref(); // recycle the "ring slot" before it is flushed
        });
        client.on('error', () => {});
      });
    });
    assert.ok(received.includes(0x42), 'net.Socket.write now copies; the staging ring may be unnecessary');
  } finally {
    client?.destroy();
    server?.close();
    fs.rmSync(sockPath, { force: true });
  }
});

test('the staging ring is larger than anything the socket can hold', () => {
  const wireBlockBytes = D.WIRE_HEADER_BYTES + 20 * 32 * 4;
  const maxOutstanding = D.SOCKET_HWM_BYTES + wireBlockBytes; // the drain loop stops at the HWM
  assert.ok(stagingSlots(wireBlockBytes) * wireBlockBytes > maxOutstanding);
});

test('every block occupies a full stride, so offsets stay computable after a short block', () => {
  const src = fs.readFileSync(new URL('../src/store/writer.ts', import.meta.url), 'utf8');
  assert.match(src, /this\.filePosition \+= this\.#g\.blockStrideBytes/);
});
