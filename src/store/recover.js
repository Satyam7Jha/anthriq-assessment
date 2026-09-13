'use strict';
// Non-finalised / truncated file recovery. PLAN §8.6.
//
// THE KEY PROPERTY: every tool uses this path UNCONDITIONALLY. Reading a still-being-written file is
// therefore the same code path as reading a SIGKILLed one — which means the recovery path is
// exercised constantly by the live UI rather than being untested crash-only code.
//
// Four properties of the format make truncation recoverable:
//   1. the header is fixed-size and written FIRST, so parameters exist from byte 0 of any file
//      longer than 4,096 bytes;
//   2. blockStrideBytes is constant, so the block count is computed, never scanned for;
//   3. each block carries its own startFrameIndex, frameCount and two CRCs, so a block is valid
//      independently of every other block and of the header's totals;
//   4. the FINALISED flag says which path to take.

const fs = require('node:fs');
const fileHeader = require('../format/file-header');
const blockHeader = require('../format/block-header');
const trailer = require('../format/trailer');
const { CAUSE_NAME } = require('../acquire/drop-ledger');

function readHeaderSync(fd) {
  const buf = Buffer.allocUnsafe(fileHeader.HEADER_BYTES);
  const got = fs.readSync(fd, buf, 0, fileHeader.HEADER_BYTES, 0);
  if (got < fileHeader.HEADER_BYTES) {
    throw new fileHeader.UnreadableError(`file shorter than a ${fileHeader.HEADER_BYTES}-byte header`);
  }
  return fileHeader.decode(buf);
}

function blockOffset(hdr, blockIndex) {
  return hdr.headerBytes + blockIndex * hdr.blockStrideBytes;
}

function readBlockHeaderSync(fd, hdr, blockIndex, buf) {
  const b = buf ?? Buffer.allocUnsafe(hdr.blockHeaderBytes);
  const got = fs.readSync(fd, b, 0, hdr.blockHeaderBytes, blockOffset(hdr, blockIndex));
  if (got < hdr.blockHeaderBytes) return null;
  return blockHeader.decode(b, 0);
}

/**
 * Establish how much of the file is trustworthy.
 * Returns { blockCount, totalFrames, totalValues, recovered, truncatedTailBytes, lastBlock }.
 */
function resolveExtent(fd, hdr, fileSize) {
  const dataBytes = Math.max(0, fileSize - hdr.headerBytes);
  // Every block occupies exactly blockStrideBytes (see writer.js — short blocks are stride-padded),
  // so the block count is computed, never scanned for. `full` counts blocks whose stride is entirely
  // within the file; the FINAL block is commonly short and so is not counted here, which the
  // finalised path below and the recovery loop each handle.
  let full = Math.floor(dataBytes / hdr.blockStrideBytes);

  if (hdr.finalised) {
    // Trust the header, but never beyond what is physically there: a file can be both finalised and
    // subsequently truncated by, say, a copy that ran out of space.
    const claimed = hdr.blockCount;
    // A finalised file's last block may be SHORT, so `claimed` legitimately exceeds `full` by one.
    // Accept it only if that block's own header is actually present and valid.
    let claimedOk = claimed <= full;
    if (!claimedOk && claimed === full + 1) {
      const lastBh = readBlockHeaderSync(fd, hdr, claimed - 1);
      claimedOk =
        !!lastBh &&
        lastBh.magicOk &&
        lastBh.headerCrcOk &&
        blockOffset(hdr, claimed - 1) + hdr.blockHeaderBytes + lastBh.payloadBytes <= fileSize;
    }
    if (claimedOk) {
      return {
        blockCount: claimed,
        totalFrames: hdr.totalFrames,
        totalValues: hdr.totalValues,
        recovered: false,
        truncatedTailBytes: 0,
      };
    }
    // Header claims more than the file holds: fall through to recovery and say so.
  }

  // --- recovery path: SIGKILL, power loss, or a file still being written ---
  let lastBlock = null;
  while (full > 0) {
    const bh = readBlockHeaderSync(fd, hdr, full - 1);
    if (bh && bh.magicOk && bh.headerCrcOk) {
      lastBlock = bh;
      break;
    }
    full -= 1; // discard the torn tail block
  }
  const totalFrames = lastBlock ? lastBlock.startFrameIndex + lastBlock.frameCount : 0;
  return {
    blockCount: full,
    totalFrames,
    totalValues: totalFrames * hdr.channelCount,
    recovered: true,
    headerClaimedBlockCount: hdr.finalised ? hdr.blockCount : null,
    truncatedTailBytes: dataBytes - full * hdr.blockStrideBytes,
    lastBlock,
  };
}

/**
 * Read the drop ledger. Prefers the header's trailerOffset; falls back to scanning BACKWARD from
 * EOF for the repeated trailer magic, which is how a non-finalised file's ledger is still findable.
 */
function readLedger(fd, hdr, fileSize) {
  const tryAt = (offset, length) => {
    if (offset <= 0 || length <= 0 || offset + length > fileSize) return null;
    const b = Buffer.allocUnsafe(length);
    fs.readSync(fd, b, 0, length, offset);
    return trailer.decode(b);
  };
  let t = hdr.hasTrailer ? tryAt(hdr.trailerOffset, hdr.trailerBytes) : null;
  if (!t) {
    // Scan back for the trailing magic. Bounded to the last 2 MiB — an unbounded backward scan over
    // a 41 GiB file would be a worse bug than a missing ledger.
    const window = Math.min(fileSize, 2 * 1024 * 1024);
    const b = Buffer.allocUnsafe(window);
    fs.readSync(fd, b, 0, window, fileSize - window);
    const idx = b.lastIndexOf(Buffer.from(trailer.MAGIC, 'latin1'));
    if (idx > 8) {
      // The tail magic sits 8 bytes past the CRC; find the matching leading magic before it.
      const lead = b.lastIndexOf(Buffer.from(trailer.MAGIC, 'latin1'), idx - 1);
      if (lead >= 0) t = trailer.decode(b.subarray(lead));
    }
  }
  if (!t) return { entries: [], crcOk: null, source: 'absent' };
  return {
    entries: t.entries.map((e) => ({ ...e, cause: CAUSE_NAME[e.causeCode] ?? `unknown(${e.causeCode})` })),
    crcOk: t.crcOk,
    source: hdr.hasTrailer ? 'header' : 'backward-scan',
  };
}

/** Open a recording read-only and describe it. The one entry point every reader tool uses. */
function openRecording(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    const hdr = readHeaderSync(fd);
    // Every reader computes offsets with the planar formula, so a file declaring any other layout
    // would be read from the wrong channels without an error. Refuse it instead (exit 3).
    if (hdr.layoutCode !== 1) {
      throw new fileHeader.UnreadableError(`unsupported layoutCode ${hdr.layoutCode} (${hdr.layoutName}); only BLOCK_PLANAR (1) is readable`);
    }
    const expectedStride = hdr.blockHeaderBytes + hdr.framesPerBlock * hdr.channelCount * hdr.bytesPerValue;
    if (hdr.blockStrideBytes !== expectedStride) {
      throw new fileHeader.UnreadableError(`blockStrideBytes ${hdr.blockStrideBytes} disagrees with the header's own layout (${expectedStride})`);
    }
    const extent = resolveExtent(fd, hdr, fileSize);
    return { fd, filePath, fileSize, hdr, extent, close: () => fs.closeSync(fd) };
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
}

module.exports = { openRecording, readHeaderSync, resolveExtent, readLedger, blockOffset, readBlockHeaderSync };
