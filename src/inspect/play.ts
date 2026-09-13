// `sigctl play` — real-time playback to stdout, controlled from stdin.
//
// stdout carries interleaved float32 little-endian frames (--out raw) or nothing (--out none); every
// human-readable line goes to stderr, so the stream can be piped into another program untouched.
// Controls: on a terminal, keys; otherwise one command per line, so a session can be scripted:
//
//   (sleep 2; echo pause; sleep 1; echo resume; echo "seek 30s"; echo "speed 4") | sigctl play FILE --out none

import readline from 'node:readline';
import type { Recording } from '../store/recover.ts';
import { createPlayer } from '../playback/player.ts';
import { parsePosition } from '../util/cli.ts';
import type { Opts } from '../util/cli.ts';
import { n } from '../util/fmt.ts';
import { parseChannels } from './read.ts';

const STDOUT_HWM_BYTES = 4 * 1024 * 1024;

export function play(rec: Recording, opts: Opts): Promise<number> {
  const { hdr, extent } = rec;
  const rate = hdr.sampleRateExactHz;
  const fromFrame = Math.max(0, parsePosition(opts.from, rate) ?? 0);
  const toFrame = Math.min(extent.endFrame, parsePosition(opts.to, rate) ?? extent.endFrame);
  const channels = parseChannels(opts.channels, hdr.channelCount);
  const format = String(opts.out ?? 'raw');
  const statsInterval = Number(opts.statsInterval ?? 1);
  if (format !== 'raw' && format !== 'none') {
    process.stderr.write('error: --out must be raw or none\n');
    return Promise.resolve(64);
  }
  if (toFrame <= fromFrame) {
    process.stderr.write(`error: empty range (${fromFrame}..${toFrame})\n`);
    return Promise.resolve(64);
  }

  const log = (s: string) => void process.stderr.write(`  ${s}\n`);
  const seconds = (frame: number) => `${(frame / rate).toFixed(3)} s`;

  return new Promise((resolve) => {
    let broken = false;
    process.stdout.on('error', () => (broken = true));

    const player = createPlayer(rec, {
      channels,
      fromFrame,
      toFrame,
      speed: Number(opts.speed ?? 1),
      emit: (frames) => {
        if (format === 'none' || broken) return true;
        if (process.stdout.writableLength > STDOUT_HWM_BYTES) return false;
        // Copy: the player reuses its buffer, and a stream write retains what it is given.
        process.stdout.write(Buffer.from(frames.slice().buffer));
        return true;
      },
      onEnd: () => finish('end of range'),
    });

    const timer = statsInterval > 0 ? setInterval(() => log(`${player.playing ? 'playing' : 'paused '}  ${seconds(player.position)}  ×${player.speed}`), statsInterval * 1000) : null;

    function command(line: string): void {
      const [op, arg] = line.trim().split(/\s+/);
      try {
        switch (op) {
          case 'pause':
            player.pause();
            return log(`pause   at ${seconds(player.position)}`);
          case 'resume':
          case 'play':
            player.play();
            return log(`resume  at ${seconds(player.position)}`);
          case 'seek': {
            const cost = player.seek(parsePosition(arg, rate) ?? player.position);
            return log(`seek    to ${seconds(player.position)}  (${cost.method}, ${cost.bytesRead} B, ${cost.microseconds.toFixed(1)} µs)`);
          }
          case 'speed':
            player.setSpeed(Number(arg));
            return log(`speed   ×${player.speed}`);
          case 'quit':
            return finish('quit');
          case '':
          case undefined:
            return;
          default:
            log(`unknown command ${JSON.stringify(op)} (pause, resume, seek T, speed X, quit)`);
        }
      } catch (e) {
        log((e as Error).message);
      }
    }

    let input: readline.Interface | null = null;
    if (process.stdin.isTTY) {
      readline.emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      process.stdin.on('keypress', (_s, key: { name?: string; sequence?: string; ctrl?: boolean }) => {
        if (key.ctrl && key.name === 'c') return finish('interrupted');
        const step = 10 * rate;
        const keys: Record<string, string> = { space: player.playing ? 'pause' : 'resume', left: `seek #${player.position - step}`, right: `seek #${player.position + step}`, q: 'quit' };
        if (key.sequence === '+' || key.sequence === '=') return command(`speed ${player.speed * 2}`);
        if (key.sequence === '-') return command(`speed ${player.speed / 2}`);
        if (key.name && keys[key.name]) command(keys[key.name]);
      });
      log('keys: space pause/resume · ← → seek 10 s · + − speed · q quit');
    } else {
      input = readline.createInterface({ input: process.stdin });
      input.on('line', command);
    }
    process.on('SIGINT', () => finish('interrupted'));

    let done = false;
    function finish(reason: string): void {
      if (done) return;
      done = true;
      player.stop();
      if (timer) clearInterval(timer);
      input?.close();
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      const r = player.report();
      process.stderr.write(
        [
          '',
          `  stopped        ${reason}, at ${seconds(r.position)} (frame ${n(r.position)})`,
          `  channels       ${channels.length} of ${hdr.channelCount}`,
          `  played         ${n(r.emittedFrames)} frames in ${r.playingSeconds.toFixed(3)} s of playing time, ${r.segments} segment(s)`,
          `  expected       ${n(r.expectedFrames)} frames  (playing time × ${n(rate)} Hz × speed)`,
          `  deviation      ${n(r.deviationFrames)} frames  (${r.deviationPpm.toFixed(1)} ppm)   bound: one tick per segment = ${n(r.leadBoundFrames)} frames  ${Math.abs(r.deviationFrames) <= r.leadBoundFrames ? 'WITHIN' : 'EXCEEDED'}`,
          `  tick lag       p99 ≤ ${n(r.worstP99Us)} µs (worst segment), max ${n(r.maxLagUs)} µs, ${n(r.lateTicks)} late tick(s)`,
          `  lost           ${n(r.gapFrames)} frames missing in the recording · ${n(r.consumerDropFrames)} dropped for a slow consumer${r.firstConsumerDropFrame >= 0 ? ` (first at frame ${n(r.firstConsumerDropFrame)})` : ''}`,
          `  bytes read     ${n(r.bytesRead)}`,
          '',
          '',
        ].join('\n')
      );
      resolve(0);
    }

    log(`playing ${seconds(fromFrame)} → ${seconds(toFrame)} at ×${player.speed}, ${channels.length} channel(s), --out ${format}`);
    player.play();
  });
}
