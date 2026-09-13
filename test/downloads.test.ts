// The CSV download carries exactly the recorded values, and a file still being written is not offered
// as a download. Served over a real HTTP socket, since backpressure and headers are the point.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSignal } from '../src/signal/signal.ts';
import { CSV_MAX_SECONDS, DownloadRefused, sendCsv, sendRecording } from '../src/server/downloads.ts';
import { C, RATE, TOTAL, writeFixture } from './fixture.ts';

async function serve(handler: (res: http.ServerResponse) => Promise<void> | void): Promise<{ url: string; close: () => void }> {
  const server = http.createServer(async (_req, res) => {
    try {
      await handler(res);
    } catch (e) {
      res.writeHead(e instanceof DownloadRefused ? 409 : 500);
      res.end((e as Error).message);
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, close: () => server.close() };
}

test('CSV rows hold the recorded values for the requested window and channels', async () => {
  const file = writeFixture();
  const channels = [3, 0];
  const { url, close } = await serve((res) => sendCsv(file, res, { fromSeconds: 0.5, seconds: 1, channels }));
  try {
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="fixture_frames-500-1500\.csv"/);
    const [head, ...rows] = (await res.text()).trim().split('\n');
    assert.equal(head, 'time_s,frame,channel_1,channel_4', 'channels are sorted and numbered from 1');
    assert.equal(rows.length, RATE, 'one second of rows, crossing a block boundary');

    const signal = createSignal({ channelCount: C });
    for (const row of rows) {
      const [time, frame, ch1, ch4] = row.split(',').map(Number);
      assert.equal(time, +(frame / RATE).toFixed(6));
      assert.equal(Math.fround(ch1), Math.fround(signal.value(0, frame)), `channel 1, frame ${frame}`);
      assert.equal(Math.fround(ch4), Math.fround(signal.value(3, frame)), `channel 4, frame ${frame}`);
    }
    assert.equal(Number(rows[0].split(',')[1]), 500);
    assert.equal(Number(rows.at(-1)!.split(',')[1]), 1499);
  } finally {
    close();
  }
});

test('the CSV window is clamped to the recording and to the download limit', async () => {
  const file = writeFixture();
  const { url, close } = await serve((res) => sendCsv(file, res, { fromSeconds: 1.5, seconds: CSV_MAX_SECONDS + 100, channels: [1] }));
  try {
    const rows = (await (await fetch(url)).text()).trim().split('\n').slice(1);
    assert.equal(rows.length, TOTAL - 1500, 'stops at the end of the recording');
  } finally {
    close();
  }
});

test('a recording still being written is refused as a file download', async () => {
  const file = writeFixture(); // the fixture is not finalised, exactly like a live recording
  const { url, close } = await serve((res) => sendRecording(file, res));
  try {
    const res = await fetch(url);
    assert.equal(res.status, 409);
    assert.match(await res.text(), /still being written/);
  } finally {
    close();
  }
});
