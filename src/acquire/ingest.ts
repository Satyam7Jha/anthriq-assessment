// The recorder's ingest state machine: accepted wire blocks -> bounded ring -> file blocks.
//
// THE INVARIANT: every file block's startFrameIndex is the true index of its first frame. A block may
// only extend the run in front of it if it is contiguous with the last frame ACCEPTED here; anything
// else — an upstream gap or a drop made here — opens a new segment whose gap goes into the header.
//
// F-01: the gap used to come from the wire parser, which only sees losses upstream. A block dropped
// here had already advanced the parser, so the next block reported "no gap", was appended to the open
// run, and every later frame index was silently short. Measuring against the last accepted frame
// gives recorder-side drops and transport gaps the same path.

import type { ByteRing } from '../ring/byte-ring.ts';
import type { DropLedger, CauseCode } from './drop-ledger.ts';
import { CAUSE } from './drop-ledger.ts';
import type { Logger } from '../util/logger.ts';

export interface IngestWriter {
  readonly canAccept: boolean;
  enqueue(block: {
    interleaved: Buffer;
    srcOffset: number;
    startFrameIndex: number;
    frameCount: number;
    precedingGapFrames: number;
    monotonicNanos: bigint;
  }): void;
}

export interface IngestOptions {
  framesPerBlock: number;
  bytesPerFrame: number;
  ring: ByteRing;
  writer: IngestWriter;
  ledger: DropLedger;
  /** One block of interleaved bytes, reused. */
  stage: Buffer;
  log?: Logger;
  now?: () => bigint;
  maxSegments?: number;
}

interface Segment {
  startFrameIndex: number;
  frames: number;
  gapBefore: number;
}

interface AcceptedBlock {
  startFrameIndex: number;
  frameCount: number;
  payloadBytes: number;
}

export function createIngest(o: IngestOptions) {
  const { ring, writer, ledger, stage, framesPerBlock, bytesPerFrame } = o;
  const now = o.now ?? (() => process.hrtime.bigint());
  const maxSegments = o.maxSegments ?? 4096;
  // One descriptor per contiguous run in the ring. Bounded: only a gap creates one.
  const segments: Segment[] = [];
  let lastAcceptedEnd = 0;

  function drop(hdr: AcceptedBlock, reason: string): false {
    ledger.record(hdr.startFrameIndex, hdr.frameCount, CAUSE.RECORDER_RING_FULL);
    o.log?.throttled('warn', reason, {
      startFrameIndex: hdr.startFrameIndex,
      frameCount: hdr.frameCount,
      ringFillPct: +(ring.fillFraction * 100).toFixed(1),
    });
    return false; // lastAcceptedEnd is NOT advanced: the next accepted block must see this hole
  }

  function emitHead(frameCount: number): void {
    const seg = segments[0];
    const len = frameCount * bytesPerFrame;
    ring.peekInto(stage, 0, len);
    writer.enqueue({
      interleaved: stage,
      srcOffset: 0,
      startFrameIndex: seg.startFrameIndex,
      frameCount,
      precedingGapFrames: seg.gapBefore,
      monotonicNanos: now(),
    });
    ring.consume(len);
    seg.startFrameIndex += frameCount;
    seg.frames -= frameCount;
    seg.gapBefore = 0;
    if (seg.frames === 0) segments.shift();
  }

  /** Hand over every whole block the writer takes; a short block only at a real boundary. */
  function drain(): void {
    while (writer.canAccept && segments.length > 0) {
      const seg = segments[0];
      if (seg.frames >= framesPerBlock) emitHead(framesPerBlock);
      else if (segments.length > 1) emitHead(seg.frames);
      else break;
    }
  }

  return {
    /** Accept one block. Returns true if its frames entered the ring. */
    onBlock(hdr: AcceptedBlock, buf: Buffer, payloadOffset: number): boolean {
      const gap = hdr.startFrameIndex - lastAcceptedEnd;
      const startsNew = segments.length === 0 || gap > 0;
      if (startsNew && segments.length >= maxSegments) return drop(hdr, 'segment-cap-reached');
      // Full ring: drop the newest, accounted by position. Never block the producer.
      if (!ring.write(buf, payloadOffset, hdr.payloadBytes)) return drop(hdr, 'recorder-ring-full');
      if (startsNew) segments.push({ startFrameIndex: hdr.startFrameIndex, frames: hdr.frameCount, gapBefore: Math.max(0, gap) });
      else segments[segments.length - 1].frames += hdr.frameCount;
      lastAcceptedEnd = hdr.startFrameIndex + hdr.frameCount;
      drain();
      return true;
    },
    drain,
    /** Shutdown: emit the next block, short final one included. False if nothing could be done. */
    flushOne(): boolean {
      if (segments.length === 0 || !writer.canAccept) return false;
      emitHead(Math.min(framesPerBlock, segments[0].frames));
      return true;
    },
    /** Shutdown on a stalled disk: ledger every frame still in the ring, by position. */
    abandonRemaining(cause: CauseCode): void {
      for (const seg of segments) {
        ledger.record(seg.startFrameIndex, seg.frames, cause);
        ring.consume(seg.frames * bytesPerFrame);
      }
      segments.length = 0;
    },
    get segmentCount() {
      return segments.length;
    },
    get residentFrames() {
      return segments.reduce((sum, s) => sum + s.frames, 0);
    },
  };
}

export type Ingest = ReturnType<typeof createIngest>;
