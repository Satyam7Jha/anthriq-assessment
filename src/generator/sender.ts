// The generator's socket side (PLAN §3.3): hand ring blocks to the recorder without ever waiting.
//
// Two rules make "a stalled consumer cannot slow the generator" true:
//   - write() is never awaited and its boolean return is ignored; the loop stops at the socket's
//     high-water mark instead, so Node's internally unbounded Writable queue never grows past it;
//   - SEND STAGING. net.Socket.write() does not copy the Buffer it is given; it keeps the reference
//     and writes later. Handing it a view into the reusable ring silently sent whatever the slot held
//     at flush time (found under a 10-second stall; pinned by test/transport.test.ts). Each block is
//     copied into a staging ring larger than HWM + one block, so a staged slot can never be recycled
//     while the socket still references it.

import net from 'node:net';
import type { BlockRing } from '../ring/block-ring.ts';
import { DEFAULTS as D } from '../config/defaults.ts';
import type { Logger } from '../util/logger.ts';

export function stagingSlots(wireBlockBytes: number): number {
  return Math.ceil(D.SOCKET_HWM_BYTES / wireBlockBytes) + 4;
}

export function createSender({ socketPath, ring, wireBlockBytes, log }: { socketPath: string | null; ring: BlockRing; wireBlockBytes: number; log: Logger }) {
  const slots = stagingSlots(wireBlockBytes);
  const stage = Buffer.allocUnsafeSlow(slots * wireBlockBytes);
  const stats = { blocksWritten: 0, bytesWritten: 0, drainStalls: 0, peakWritableLength: 0, connected: false };
  let slot = 0;
  let socket: net.Socket | null = null;
  let closed = false;

  function connect(): void {
    if (!socketPath || closed) return;
    // Node's Duplex honours writableHighWaterMark; @types/node just omits it from the socket options.
    const socketOptions: net.SocketConstructorOpts & { writableHighWaterMark: number } = { writableHighWaterMark: D.SOCKET_HWM_BYTES };
    const s = new net.Socket(socketOptions).connect({ path: socketPath });
    socket = s;
    s.on('connect', () => {
      stats.connected = true;
      log.info('connected', { socketPath });
    });
    // Never fatal: a missing or crashed recorder must not stop the generator.
    s.on('error', (err: NodeJS.ErrnoException) => log.throttled('warn', 'socket-error', { code: err.code }, 2000));
    s.on('close', () => {
      stats.connected = false;
      if (!closed) setTimeout(connect, 250).unref(); // reconnect; the gap is reported by position
    });
  }

  /** Run at the end of every tick. Allocates nothing, awaits nothing. */
  function drain(): void {
    if (!socketPath) {
      while (ring.pop()); // --sink null: measure pacing with no consumer at all
      return;
    }
    if (!stats.connected || !socket || !socket.writable) return;
    for (let block = ring.peek(); block; block = ring.peek()) {
      const queued = socket.writableLength;
      stats.peakWritableLength = Math.max(stats.peakWritableLength, queued);
      if (queued >= D.SOCKET_HWM_BYTES) {
        stats.drainStalls++;
        return;
      }
      const off = slot * wireBlockBytes;
      block.copy(stage, off);
      socket.write(stage.subarray(off, off + block.length));
      slot = (slot + 1) % slots;
      stats.blocksWritten++;
      stats.bytesWritten += block.length;
      ring.pop();
    }
  }

  function close(done: () => void): void {
    closed = true;
    if (socket && !socket.destroyed) socket.end(done);
    else done();
  }

  return { connect, drain, close, stats, stagingSlots: slots };
}
