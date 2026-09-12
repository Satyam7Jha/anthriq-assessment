#!/usr/bin/env python3
"""
An independent reader for the .sigb format.

THE POINT OF THIS FILE: the assessment requires that a recording be "fully interpretable without
reference to the source code", and that the format be documented "in detail enough for a third party
to write an independent reader". This script is the proof rather than the claim.

It was written from docs/FORMAT.md ALONE. It imports nothing from src/, shells out to nothing, and
shares no constant with the JavaScript implementation — every offset, magic number and polynomial
below was transcribed from the specification document by hand. If this script reads a recording
correctly, the specification is sufficient. If it does not, the specification is wrong, and that is
a defect in the deliverable rather than in this script.

Standard library only; no numpy.

Usage:
    python3 tools/independent_reader.py FILE.sigb                     # metadata
    python3 tools/independent_reader.py FILE.sigb --check             # verify every block CRC
    python3 tools/independent_reader.py FILE.sigb --channels 3,17 --from 10 --to 12
    python3 tools/independent_reader.py FILE.sigb --dump 5            # first 5 values per channel

Exit: 0 ok, 1 integrity failure, 3 unreadable.
"""

import argparse
import json
import os
import struct
import sys
import uuid

# --- CRC-32C (Castagnoli), from FORMAT.md section 8 ---------------------------------------------
_TABLE = []
for _i in range(256):
    _c = _i
    for _ in range(8):
        _c = (_c >> 1) ^ (0x82F63B78 if _c & 1 else 0)
    _TABLE.append(_c)


def crc32c(data: bytes, crc: int = 0xFFFFFFFF) -> int:
    for b in data:
        crc = (crc >> 8) ^ _TABLE[(crc ^ b) & 0xFF]
    return crc ^ 0xFFFFFFFF


assert crc32c(b"123456789") == 0xE3069283, "CRC-32C check value from FORMAT.md section 8 failed"

FILE_MAGIC = b"SIGBLK01"
BLOCK_MAGIC = 0x424C4B42  # "BLKB"
TRAILER_MAGIC = b"SIGTRLR1"

DTYPES = {1: ("float32", 4, "<f"), 2: ("float64", 8, "<d"), 3: ("int16", 2, "<h"), 4: ("int32", 4, "<i")}
LAYOUTS = {1: "BLOCK_PLANAR", 2: "BLOCK_INTERLEAVED"}
CAUSES = {
    1: "GENERATOR_RING_FULL",
    2: "RECORDER_RING_FULL",
    3: "PACING_RESYNC",
    4: "TRANSPORT_GAP",
    5: "CORRUPT_FRAMES",
    6: "GENERATOR_DISCONNECT",
}

FLAG_FINALISED = 1 << 0
FLAG_HAS_TRAILER = 1 << 1
FLAG_HAD_DROPS = 1 << 2
FLAG_LEDGER_TRUNCATED = 1 << 3
FLAG_DITHER_DISABLED = 1 << 4


class Unreadable(Exception):
    pass


def _ascii(raw: bytes) -> str:
    z = raw.find(b"\x00")
    return raw[: z if z >= 0 else len(raw)].decode("latin1")


def read_file_header(f):
    """FORMAT.md section 2. Offsets transcribed from the table."""
    f.seek(0)
    raw = f.read(4096)
    if len(raw) < 4096:
        raise Unreadable(f"file shorter than a 4,096-byte header ({len(raw)} B)")
    if raw[0:8] != FILE_MAGIC:
        raise Unreadable(f"bad magic: expected {FILE_MAGIC!r}, got {raw[0:8]!r}")

    endianness = struct.unpack_from("<I", raw, 12)[0]
    if endianness != 0x01020304:
        # A big-endian file would need every field byte-swapped. Detect and refuse rather than
        # silently misread.
        raise Unreadable(f"file is big-endian (marker 0x{endianness:08x}); this reader handles little-endian only")

    stored_crc = struct.unpack_from("<I", raw, 4092)[0]
    if crc32c(raw[:4092]) != stored_crc:
        raise Unreadable("header CRC-32C mismatch — the header is torn or corrupt")

    version = struct.unpack_from("<H", raw, 8)[0]
    if version != 1:
        raise Unreadable(f"unsupported formatVersion {version}")

    dtype_code = struct.unpack_from("<H", raw, 48)[0]
    layout_code = struct.unpack_from("<I", raw, 52)[0]
    flags = struct.unpack_from("<I", raw, 140)[0]

    h = {
        "magic": raw[0:8].decode("latin1"),
        "formatVersion": version,
        "headerBytes": struct.unpack_from("<H", raw, 10)[0],
        "endianness": endianness,
        "recordingId": str(uuid.UUID(bytes=raw[16:32])),
        "channelCount": struct.unpack_from("<I", raw, 32)[0],
        "sampleRateHz": struct.unpack_from("<I", raw, 36)[0],
        "sampleRateExactHz": struct.unpack_from("<d", raw, 40)[0],
        "dtypeCode": dtype_code,
        "dtypeName": DTYPES.get(dtype_code, (f"unknown({dtype_code})", 0, None))[0],
        "bytesPerValue": struct.unpack_from("<H", raw, 50)[0],
        "layoutCode": layout_code,
        "layoutName": LAYOUTS.get(layout_code, f"unknown({layout_code})"),
        "framesPerBlock": struct.unpack_from("<I", raw, 56)[0],
        "blockHeaderBytes": struct.unpack_from("<I", raw, 60)[0],
        "blockStrideBytes": struct.unpack_from("<Q", raw, 64)[0],
        "totalFrames": struct.unpack_from("<Q", raw, 72)[0],
        "totalValues": struct.unpack_from("<Q", raw, 80)[0],
        "blockCount": struct.unpack_from("<Q", raw, 88)[0],
        "durationSeconds": struct.unpack_from("<d", raw, 96)[0],
        "startTimestampUnixNanos": struct.unpack_from("<Q", raw, 104)[0],
        "endTimestampUnixNanos": struct.unpack_from("<Q", raw, 112)[0],
        "startMonotonicNanos": struct.unpack_from("<Q", raw, 120)[0],
        "trailerOffset": struct.unpack_from("<Q", raw, 128)[0],
        "trailerBytes": struct.unpack_from("<I", raw, 136)[0],
        "flags": flags,
        "finalised": bool(flags & FLAG_FINALISED),
        "hasTrailer": bool(flags & FLAG_HAS_TRAILER),
        "hadDrops": bool(flags & FLAG_HAD_DROPS),
        "ledgerTruncated": bool(flags & FLAG_LEDGER_TRUNCATED),
        "ditherDisabled": bool(flags & FLAG_DITHER_DISABLED),
        "droppedFramesTotal": struct.unpack_from("<Q", raw, 144)[0],
        "ledgerEntryCount": struct.unpack_from("<I", raw, 152)[0],
        "ringBytes": struct.unpack_from("<I", raw, 156)[0],
        "fsyncIntervalSeconds": struct.unpack_from("<I", raw, 160)[0],
        "generatorTickNanos": struct.unpack_from("<I", raw, 164)[0],
        "signalId": _ascii(raw[168:200]),
        "producer": _ascii(raw[200:264]),
        "description": _ascii(raw[264:520]),
    }
    # Cross-check the one derived field the spec states explicitly. A mismatch means either the
    # file is inconsistent or this reader has misread an offset - both worth saying out loud.
    expected_stride = h["blockHeaderBytes"] + h["framesPerBlock"] * h["channelCount"] * h["bytesPerValue"]
    if expected_stride != h["blockStrideBytes"]:
        print(
            f"warning: blockStrideBytes {h['blockStrideBytes']} != derived {expected_stride}",
            file=sys.stderr,
        )
    return h


def block_offset(h, block_index):
    """FORMAT.md section 5.1. Every block occupies a full stride, short ones included."""
    return h["headerBytes"] + block_index * h["blockStrideBytes"]


def read_block_header(f, h, block_index):
    """FORMAT.md section 3."""
    f.seek(block_offset(h, block_index))
    raw = f.read(h["blockHeaderBytes"])
    if len(raw) < h["blockHeaderBytes"]:
        return None
    if struct.unpack_from("<I", raw, 0)[0] != BLOCK_MAGIC:
        return None
    if crc32c(raw[:60]) != struct.unpack_from("<I", raw, 60)[0]:
        return None
    flags = struct.unpack_from("<I", raw, 36)[0]
    return {
        "startFrameIndex": struct.unpack_from("<Q", raw, 4)[0],
        "frameCount": struct.unpack_from("<I", raw, 12)[0],
        "payloadBytes": struct.unpack_from("<I", raw, 16)[0],
        "blockIndex": struct.unpack_from("<Q", raw, 20)[0],
        "monotonicNanos": struct.unpack_from("<Q", raw, 28)[0],
        "flags": flags,
        "shortBlock": bool(flags & 1),
        "precededByGap": bool(flags & 2),
        "precedingGapFrames": struct.unpack_from("<I", raw, 40)[0],
        "payloadCrc32c": struct.unpack_from("<I", raw, 56)[0],
    }


def resolve_extent(f, h, file_size):
    """FORMAT.md section 6 — the recovery path, used unconditionally."""
    data_bytes = max(0, file_size - h["headerBytes"])
    full = data_bytes // h["blockStrideBytes"]

    if h["finalised"]:
        claimed = h["blockCount"]
        ok = claimed <= full
        if not ok and claimed == full + 1:
            # A finalised file's LAST block may legitimately be short.
            last = read_block_header(f, h, claimed - 1)
            ok = last is not None and block_offset(h, claimed - 1) + h["blockHeaderBytes"] + last["payloadBytes"] <= file_size
        if ok:
            return {"blockCount": claimed, "totalFrames": h["totalFrames"], "recovered": False}

    n = full
    total = 0
    while n > 0:
        bh = read_block_header(f, h, n - 1)
        if bh is not None:
            total = bh["startFrameIndex"] + bh["frameCount"]
            break
        n -= 1  # discard the torn tail block
    return {"blockCount": n, "totalFrames": total, "recovered": True}


def read_trailer(f, h, file_size):
    """FORMAT.md section 7."""
    if h["hasTrailer"] and h["trailerOffset"] and h["trailerOffset"] + h["trailerBytes"] <= file_size:
        f.seek(h["trailerOffset"])
        raw = f.read(h["trailerBytes"])
    else:
        # Scan backward for the repeated magic, which is why it is repeated.
        window = min(file_size, 2 * 1024 * 1024)
        f.seek(file_size - window)
        buf = f.read(window)
        tail = buf.rfind(TRAILER_MAGIC)
        if tail <= 0:
            return []
        lead = buf.rfind(TRAILER_MAGIC, 0, tail)
        if lead < 0:
            return []
        raw = buf[lead:]
    if len(raw) < 24 or raw[0:8] != TRAILER_MAGIC:
        return []
    count = struct.unpack_from("<I", raw, 8)[0]
    end = 12 + count * 24
    if end + 4 > len(raw):
        return []
    if crc32c(raw[:end]) != struct.unpack_from("<I", raw, end)[0]:
        print("warning: trailer CRC mismatch — ledger not trusted", file=sys.stderr)
        return []
    out = []
    for i in range(count):
        o = 12 + i * 24
        code = struct.unpack_from("<I", raw, o + 16)[0]
        out.append(
            {
                "startFrameIndex": struct.unpack_from("<Q", raw, o)[0],
                "frameCount": struct.unpack_from("<Q", raw, o + 8)[0],
                "cause": CAUSES.get(code, f"unknown({code})"),
            }
        )
    return out


def find_block(f, h, extent, frame_index):
    """FORMAT.md section 5.1 / 5.2 — closed form, with a binary-search fallback after drops."""
    guess = frame_index // h["framesPerBlock"]
    if 0 <= guess < extent["blockCount"]:
        bh = read_block_header(f, h, guess)
        if bh and bh["startFrameIndex"] <= frame_index < bh["startFrameIndex"] + bh["frameCount"]:
            return guess, bh, "closed-form", 1

    lo, hi, probes = 0, extent["blockCount"] - 1, 1
    while lo <= hi:
        mid = (lo + hi) // 2
        bh = read_block_header(f, h, mid)
        probes += 1
        if bh is None:
            hi = mid - 1
            continue
        if frame_index < bh["startFrameIndex"]:
            hi = mid - 1
        elif frame_index >= bh["startFrameIndex"] + bh["frameCount"]:
            lo = mid + 1
        else:
            return mid, bh, "binary-search", probes
    return None, None, "not-found", probes


def read_channel_run(f, h, block_index, bh, channel, first_frame_in_block, count):
    """FORMAT.md section 4. Note the channel stride is frameCount, NOT framesPerBlock."""
    _, width, fmt = DTYPES[h["dtypeCode"]]
    offset = (
        block_offset(h, block_index)
        + h["blockHeaderBytes"]
        + (channel * bh["frameCount"] + first_frame_in_block) * width
    )
    f.seek(offset)
    raw = f.read(count * width)
    return list(struct.unpack(f"<{count}{fmt[1]}", raw)), len(raw)


def main():
    ap = argparse.ArgumentParser(description="Independent .sigb reader, written from docs/FORMAT.md alone")
    ap.add_argument("file")
    ap.add_argument("--check", action="store_true", help="verify every block's payload CRC and sequence")
    ap.add_argument("--channels", default=None, help="comma-separated channel indices")
    ap.add_argument("--from", dest="from_s", type=float, default=None, help="start time in seconds")
    ap.add_argument("--to", dest="to_s", type=float, default=None, help="end time in seconds")
    ap.add_argument("--dump", type=int, default=0, help="print the first N values per selected channel")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    file_size = os.path.getsize(args.file)
    with open(args.file, "rb") as f:
        try:
            h = read_file_header(f)
        except Unreadable as e:
            print(f"UNREADABLE: {e}", file=sys.stderr)
            return 3
        extent = resolve_extent(f, h, file_size)
        ledger = read_trailer(f, h, file_size)

        if args.json:
            print(json.dumps({"header": h, "extent": extent, "ledger": ledger}, indent=2, default=str))
        else:
            print(f"  file                 {args.file}")
            print(f"  size                 {file_size:,} B")
            print(f"  format               {h['magic']} v{h['formatVersion']}  header {h['headerBytes']} B")
            print(f"  recordingId          {h['recordingId']}")
            print(f"  channelCount         {h['channelCount']}")
            print(f"  sampleRateHz         {h['sampleRateExactHz']:g}")
            print(f"  dataType             {h['dtypeName']}  {h['bytesPerValue']} B/value  little-endian")
            print(f"  layout               {h['layoutName']}  framesPerBlock {h['framesPerBlock']:,}")
            print(f"  blockStrideBytes     {h['blockStrideBytes']:,}")
            print(f"  totalFrames          {extent['totalFrames']:,}")
            print(f"  totalValues          {extent['totalFrames'] * h['channelCount']:,}")
            print(f"  duration             {extent['totalFrames'] / h['sampleRateExactHz']:.6f} s")
            print(f"  blockCount           {extent['blockCount']:,}")
            print(f"  finalised            {'yes' if h['finalised'] else 'NO — totals reconstructed'}")
            print(f"  recoveryUsed         {'yes' if extent['recovered'] else 'no'}")
            print(f"  signalId             {h['signalId']}")
            print(f"  producer             {h['producer']}")
            print(f"  droppedFrames        {h['droppedFramesTotal']:,}")
            print(f"  ledgerEntries        {len(ledger)}")
            for e in ledger[:10]:
                print(
                    f"      frame {e['startFrameIndex']:>12,}  +{e['frameCount']:>9,} frames"
                    f"   t={e['startFrameIndex'] / h['sampleRateExactHz']:.3f}s   {e['cause']}"
                )

        rc = 0

        # --- sidecar association check (FORMAT.md section 9) ---
        sidecar_path = args.file[:-5] + ".json" if args.file.endswith(".sigb") else args.file + ".json"
        if os.path.exists(sidecar_path):
            try:
                with open(sidecar_path) as sf:
                    sc = json.load(sf)
                match = sc.get("recordingId", "").replace("-", "") == h["recordingId"].replace("-", "")
                print(f"  sidecar              {'recordingId matches' if match else 'MISMATCH — header wins'}")
                if not match:
                    rc = 1
            except Exception as e:  # noqa: BLE001
                print(f"  sidecar              unreadable: {e}")

        # --- full integrity sweep ---
        if args.check:
            print("\n  verifying every block: magic, header CRC, payload CRC, sequence continuity")
            expected_next = None
            bad_crc = gaps = gap_frames = bad_header = 0
            for b in range(extent["blockCount"]):
                bh = read_block_header(f, h, b)
                if bh is None:
                    bad_header += 1
                    continue
                if expected_next is None:
                    expected_next = bh["startFrameIndex"]
                if bh["startFrameIndex"] > expected_next:
                    gaps += 1
                    gap_frames += bh["startFrameIndex"] - expected_next
                expected_next = bh["startFrameIndex"] + bh["frameCount"]
                f.seek(block_offset(h, b) + h["blockHeaderBytes"])
                if crc32c(f.read(bh["payloadBytes"])) != bh["payloadCrc32c"]:
                    bad_crc += 1
            print(f"    blocks checked     {extent['blockCount']:,}")
            print(f"    bad block headers  {bad_header}")
            print(f"    payload CRC fails  {bad_crc}")
            print(f"    sequence gaps      {gaps}  ({gap_frames:,} frames = {gap_frames * h['channelCount']:,} values)")
            # Independently derived from block headers alone; must equal the recorder's own ledger.
            ledger_frames = sum(e["frameCount"] for e in ledger)
            agree = ledger_frames == gap_frames
            print(f"    recorder ledger    {ledger_frames:,} frames — {'AGREES' if agree else 'DISAGREES'}")
            if bad_crc or bad_header or not agree:
                rc = 1
            print(f"\n  {'INTEGRITY OK' if rc == 0 else 'INTEGRITY FAILURE'}")

        # --- range + channel-subset read ---
        if args.channels is not None:
            channels = [int(c) for c in args.channels.split(",")]
            rate = h["sampleRateExactHz"]
            from_frame = int((args.from_s or 0) * rate)
            to_frame = int(args.to_s * rate) if args.to_s is not None else min(from_frame + int(rate), extent["totalFrames"])
            to_frame = min(to_frame, extent["totalFrames"])

            bi, bh, method, probes = find_block(f, h, extent, from_frame)
            if bi is None:
                print(f"\n  frame {from_frame} not present in this recording", file=sys.stderr)
                return 1
            print(f"\n  seek to frame {from_frame:,}: block {bi}, {method}, {probes} header read(s) = {probes * 64} B")

            bytes_read = 0
            values = {c: [] for c in channels}
            b = bi
            while b < extent["blockCount"]:
                cbh = read_block_header(f, h, b)
                bytes_read += h["blockHeaderBytes"]
                if cbh is None or cbh["startFrameIndex"] >= to_frame:
                    break
                lo = max(from_frame, cbh["startFrameIndex"])
                hi = min(to_frame, cbh["startFrameIndex"] + cbh["frameCount"])
                if hi > lo:
                    for c in channels:
                        vals, nbytes = read_channel_run(f, h, b, cbh, c, lo - cbh["startFrameIndex"], hi - lo)
                        values[c].extend(vals)
                        bytes_read += nbytes
                if cbh["startFrameIndex"] + cbh["frameCount"] >= to_frame:
                    break
                b += 1

            frames = to_frame - from_frame
            all_ch = bytes_read if not channels else (bytes_read - (b - bi + 1) * h["blockHeaderBytes"]) * h["channelCount"] / len(channels) + (b - bi + 1) * h["blockHeaderBytes"]
            print(f"  channels             {channels}  ({len(channels)} of {h['channelCount']})")
            print(f"  frames               {frames:,}  ({frames / h['sampleRateExactHz']:.3f} s)")
            print(f"  bytes read           {bytes_read:,}")
            print(f"  all-channel equiv.   {int(all_ch):,}   =>  {all_ch / bytes_read:.2f}x fewer bytes read")
            if args.dump:
                for c in channels:
                    head = ", ".join(f"{v:+.9f}" for v in values[c][: args.dump])
                    print(f"    ch{c:02d}  {head}")
        return rc


if __name__ == "__main__":
    sys.exit(main())
