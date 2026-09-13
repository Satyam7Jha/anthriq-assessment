// Opening a recording, including truncated and still-being-written ones (PLAN §8.6).
//
// Every tool uses this path unconditionally, so reading a live file and reading a SIGKILLed one are
// the same code — the recovery path is exercised constantly, not only after a crash. It works because
// the header is written first, the stride is constant, and each block carries its own position and
// CRCs.

import fs from 'node:fs';
import * as fileHeader from '../format/file-header.ts';
import * as blockHeader from '../format/block-header.ts';
import * as trailer from '../format/trailer.ts';
import type { FileHeader } from '../format/file-header.ts';
import type { BlockHeader } from '../format/block-header.ts';
import { CAUSE_NAME } from '../acquire/drop-ledger.ts';
import type { LedgerEntry } from '../acquire/drop-ledger.ts';

export interface Extent {
  blockCount: number;
  /** Frames actually recorded. */
  totalFrames: number;
  /**
   * One past the last frame index in the file — where the timeline ends. Differs from totalFrames when
   * the recording has gaps (a sleep, a stalled disk), because frame indices keep counting across them.
   */
  endFrame: number;
  totalValues: number;
  recovered: boolean;
  truncatedTailBytes: number;
}

export interface Recording {
  fd: number;
  filePath: string;
  fileSize: number;
  hdr: FileHeader;
  extent: Extent;
  close: () => void;
}

export const blockOffset = (hdr: FileHeader, blockIndex: number): number => hdr.headerBytes + blockIndex * hdr.blockStrideBytes;

export function readBlockHeader(fd: number, hdr: FileHeader, blockIndex: number, buf = Buffer.allocUnsafe(hdr.blockHeaderBytes)): BlockHeader | null {
  if (fs.readSync(fd, buf, 0, hdr.blockHeaderBytes, blockOffset(hdr, blockIndex)) < hdr.blockHeaderBytes) return null;
  const bh = blockHeader.decode(buf, 0);
  return bh.magicOk && bh.headerCrcOk ? bh : null;
}

function resolveExtent(fd: number, hdr: FileHeader, fileSize: number): Extent {
  const dataBytes = Math.max(0, fileSize - hdr.headerBytes);
  let full = Math.floor(dataBytes / hdr.blockStrideBytes);

  if (hdr.finalised) {
    // Trust the header, never beyond what is physically present. The last block may be short, so
    // blockCount may exceed whole strides by one — accept that only if its own header checks out.
    const claimed = hdr.blockCount;
    let ok = claimed <= full;
    if (!ok && claimed === full + 1) {
      const last = readBlockHeader(fd, hdr, claimed - 1);
      ok = !!last && blockOffset(hdr, claimed - 1) + hdr.blockHeaderBytes + last.payloadBytes <= fileSize;
    }
    if (ok) {
      const tail = claimed > 0 ? readBlockHeader(fd, hdr, claimed - 1) : null;
      const endFrame = tail ? tail.startFrameIndex + tail.frameCount : hdr.totalFrames;
      return { blockCount: claimed, totalFrames: hdr.totalFrames, totalValues: hdr.totalValues, endFrame, recovered: false, truncatedTailBytes: 0 };
    }
  }

  // Recovery: SIGKILL, power loss, or a live file. Walk back past any torn tail block.
  let last: BlockHeader | null = null;
  while (full > 0 && !(last = readBlockHeader(fd, hdr, full - 1))) full--;
  const totalFrames = last ? last.startFrameIndex + last.frameCount : 0;
  return {
    blockCount: full,
    totalFrames,
    totalValues: totalFrames * hdr.channelCount,
    endFrame: totalFrames,
    recovered: true,
    truncatedTailBytes: dataBytes - full * hdr.blockStrideBytes,
  };
}

/** The drop ledger: from the header's trailer offset, else by scanning back from EOF for the magic. */
export function readLedger(rec: Pick<Recording, 'fd' | 'hdr' | 'fileSize'>): { entries: LedgerEntry[]; source: string } {
  const { fd, hdr, fileSize } = rec;
  let t: ReturnType<typeof trailer.decode> = null;
  if (hdr.hasTrailer && hdr.trailerOffset > 0 && hdr.trailerOffset + hdr.trailerBytes <= fileSize) {
    const b = Buffer.allocUnsafe(hdr.trailerBytes);
    fs.readSync(fd, b, 0, hdr.trailerBytes, hdr.trailerOffset);
    t = trailer.decode(b);
  }
  if (!t) {
    // Bounded to the last 2 MiB: an unbounded backward scan of a 41 GiB file is a worse bug.
    const window = Math.min(fileSize, 2 * 1024 * 1024);
    const b = Buffer.allocUnsafe(window);
    fs.readSync(fd, b, 0, window, fileSize - window);
    const magic = Buffer.from(trailer.MAGIC, 'latin1');
    const tail = b.lastIndexOf(magic);
    const lead = tail > 8 ? b.lastIndexOf(magic, tail - 1) : -1;
    if (lead >= 0) t = trailer.decode(b.subarray(lead));
  }
  if (!t) return { entries: [], source: 'absent' };
  return {
    entries: t.entries.map((e) => ({ ...e, cause: CAUSE_NAME[e.causeCode] ?? `unknown(${e.causeCode})` })),
    source: hdr.hasTrailer ? 'header' : 'backward-scan',
  };
}

/** Open a recording read-only. The single entry point every reader tool uses. */
export function openRecording(filePath: string): Recording {
  const fd = fs.openSync(filePath, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    const buf = Buffer.allocUnsafe(fileHeader.HEADER_BYTES);
    if (fs.readSync(fd, buf, 0, fileHeader.HEADER_BYTES, 0) < fileHeader.HEADER_BYTES) {
      throw new fileHeader.UnreadableError(`file shorter than a ${fileHeader.HEADER_BYTES}-byte header`);
    }
    const hdr = fileHeader.decode(buf);
    // Readers compute offsets with the planar formula; any other layout would read the wrong channels.
    if (hdr.layoutCode !== 1) throw new fileHeader.UnreadableError(`unsupported layout ${hdr.layoutName}; only BLOCK_PLANAR is readable`);
    const expectedStride = hdr.blockHeaderBytes + hdr.framesPerBlock * hdr.channelCount * hdr.bytesPerValue;
    if (hdr.blockStrideBytes !== expectedStride) throw new fileHeader.UnreadableError(`blockStrideBytes ${hdr.blockStrideBytes} contradicts the header's layout (${expectedStride})`);
    return { fd, filePath, fileSize, hdr, extent: resolveExtent(fd, hdr, fileSize), close: () => fs.closeSync(fd) };
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
}
