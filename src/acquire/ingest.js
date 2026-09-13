'use strict';
// The recorder's ingest state machine: accepted wire blocks -> bounded ring -> file blocks.
//
// Extracted from bin/recorder.js so it can be tested without sockets, disks or timers. The review
// that found F-01 was right that the bug lived exactly where no test could reach.
//
// THE INVARIANT this module exists to keep: every file block's startFrameIndex is the true index of
// its first frame. A block may only extend the run in front of it if it is contiguous with the last
// frame this module ACCEPTED. Anything else — an upstream transport gap, or a drop this module made
// itself — opens a new segment whose gap is written into the block header.
//
// F-01, for the record: the gap used to come from the wire parser, which only knows about losses
// UPSTREAM of the recorder. A block dropped here because the ring was full had already advanced the
// parser, so the next block reported "no gap", was appended to the open run, and every frame index
// after it was silently short by the number of frames dropped — CRC-clean and wrong. The gap is now
// measured against the last frame actually accepted, so a recorder-side drop and a transport gap
// take the same path.

const { CAUSE } = require('./drop-ledger');

const DEFAULT_MAX_SEGMENTS = 4096;

/**
 * @param {object} o
 * @param {object} o.cfg          resolved config (framesPerBlock, bytesPerFrame)
 * @param {import('../ring/byte-ring').ByteRing} o.ring
 * @param {{canAccept:boolean, enqueue:Function}} o.writer
 * @param {import('./drop-ledger').DropLedger} o.ledger
 * @param {Buffer} o.stage        one block's worth of interleaved bytes, reused
 * @param {{throttled:Function}} [o.log]
 * @param {() => bigint} [o.now]
 * @param {number} [o.maxSegments]
 */
function createIngest({ cfg, ring, writer, ledger, stage, log, now = () => process.hrtime.bigint(), maxSegments = DEFAULT_MAX_SEGMENTS }) {
  // One descriptor per contiguous run of frame indices currently resident in the ring. Bounded: a
  // segment can only be created by a gap, and the cap turns a pathologically flapping source into
  // accounted loss rather than time-proportional memory.
  const segments = []; // [{ startFrameIndex, frames, gapBefore }]
  let lastAcceptedEnd = 0; // frame index one past the last frame accepted into the ring
  const stats = { acceptedFrames: 0, droppedFrames: 0 };

  function drop(hdr, reason) {
    ledger.record(hdr.startFrameIndex, hdr.frameCount, CAUSE.RECORDER_RING_FULL);
    stats.droppedFrames += hdr.frameCount;
    log?.throttled('warn', reason, {
      startFrameIndex: hdr.startFrameIndex,
      frameCount: hdr.frameCount,
      totalDroppedFrames: ledger.totalDroppedFrames,
      ringFillPct: +(ring.fillFraction * 100).toFixed(1),
    });
    // Deliberately NOT advancing lastAcceptedEnd: the next accepted block must see this hole.
    return false;
  }

  /** Accept one wire block. Returns true if its frames entered the ring. */
  function onBlock(hdr, buf, payloadOffset) {
    const gap = hdr.startFrameIndex - lastAcceptedEnd; // the parser guarantees this is >= 0
    const startsNewSegment = segments.length === 0 || gap > 0;

    if (startsNewSegment && segments.length >= maxSegments) return drop(hdr, 'segment-cap-reached');
    // Policy on a full ring: DROP-NEWEST, accounted with position. Not drop-oldest, which would mean
    // rewriting committed blocks; not blocking the producer, which the brief forbids.
    if (!ring.write(buf, payloadOffset, hdr.payloadBytes)) return drop(hdr, 'recorder-ring-full');

    if (startsNewSegment) {
      segments.push({ startFrameIndex: hdr.startFrameIndex, frames: hdr.frameCount, gapBefore: Math.max(0, gap) });
    } else {
      segments[segments.length - 1].frames += hdr.frameCount;
    }
    lastAcceptedEnd = hdr.startFrameIndex + hdr.frameCount;
    stats.acceptedFrames += hdr.frameCount;
    drain();
    return true;
  }

  /** Hand one block from the head segment to the writer. */
  function emitHead(frameCount) {
    const seg = segments[0];
    const bytes = frameCount * cfg.bytesPerFrame;
    ring.peekInto(stage, 0, bytes);
    writer.enqueue({
      interleaved: stage,
      srcOffset: 0,
      startFrameIndex: seg.startFrameIndex,
      frameCount,
      precedingGapFrames: seg.gapBefore, // only the first block of a segment follows its gap
      monotonicNanos: now(),
    });
    ring.consume(bytes);
    seg.startFrameIndex += frameCount;
    seg.frames -= frameCount;
    seg.gapBefore = 0;
    if (seg.frames === 0) segments.shift();
  }

  /**
   * Give the writer every whole block it will take. A short block is emitted only at a real
   * boundary (a later segment exists), never speculatively. Frames that do not fit stay in the ring,
   * which keeps the ring the only queue.
   */
  function drain() {
    while (writer.canAccept && segments.length > 0) {
      const seg = segments[0];
      if (seg.frames >= cfg.framesPerBlock) emitHead(cfg.framesPerBlock);
      else if (segments.length > 1) emitHead(seg.frames);
      else break;
    }
  }

  /** Shutdown: emit the next block including a short final one. Returns false if nothing was done. */
  function flushOne() {
    if (segments.length === 0 || !writer.canAccept) return false;
    emitHead(Math.min(cfg.framesPerBlock, segments[0].frames));
    return true;
  }

  /**
   * Shutdown when the disk will not drain in time: account for every frame still in the ring as a
   * positioned loss, so the ledger that reaches disk tells the truth about the tail.
   */
  function abandonRemaining(cause) {
    for (const seg of segments) {
      ledger.record(seg.startFrameIndex, seg.frames, cause);
      ring.consume(seg.frames * cfg.bytesPerFrame);
    }
    segments.length = 0;
  }

  return {
    onBlock,
    drain,
    flushOne,
    abandonRemaining,
    stats,
    get segmentCount() {
      return segments.length;
    },
    get residentFrames() {
      return segments.reduce((a, s) => a + s.frames, 0);
    },
  };
}

module.exports = { createIngest };
