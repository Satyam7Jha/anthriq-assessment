# `.sigb` — Signal Block Format, version 1

A complete specification. **Everything needed to write an independent reader is in this document**;
no source code is required. `tools/independent_reader.py` was written from this text alone and
imports nothing from `src/` — its existence is the proof of that claim.

---

## 0. At a glance

```
byte 0                                                                              EOF
┌──────────────┬──────────────┬──────────────┬─────┬──────────────┬─────────────────┐
│  FILE HEADER │  BLOCK 0     │  BLOCK 1     │ ... │  BLOCK N-1   │  TRAILER        │
│  4,096 B     │  512,064 B   │  512,064 B   │     │  <=512,064 B │  variable       │
│  fixed       │              │              │     │  may be SHORT│  optional       │
└──────────────┴──────────────┴──────────────┴─────┴──────────────┴─────────────────┘
 offset 0       offset 4096    offset 516160
```

- All integers and floats are **little-endian** unless the header's `endianness` field says
  otherwise. A reader **MUST** check that field rather than assume.
- **Every block occupies exactly `blockStrideBytes` on disk**, including a short one. This is the
  invariant that makes seeking closed-form. Only the **final** block may be physically truncated.
- A sidecar `<stem>.json` accompanies the file. **The embedded header is authoritative**; the sidecar
  is a human-readable mirror. If they disagree, the header wins and a reader SHOULD warn.

Defaults referred to throughout: 32 channels, 4,000 Hz, float32, 4,000 frames per block.

---

## 1. Vocabulary

| Term | Meaning |
|---|---|
| **value** | One scalar reading from one channel. The assessment's "sample". |
| **frame** | One time-slice across all channels = `channelCount` values. |
| **frameIndex** | Absolute, monotonic, 0-based index of a frame since run start. Never reused, never reset, **survives drops**. |
| **block** | The unit of storage and of O(1) seek. Nominally 1 second of frames. |

`totalValues = totalFrames * channelCount`. The assessment counts **values**.

---

## 2. File header — exactly 4,096 bytes at offset 0

4,096 bytes is one page: it leaves room for future fields without moving anything, and it aligns
block 0 to a page boundary.

| Off | Size | Type | Field | Notes |
|---:|---:|---|---|---|
| 0 | 8 | char[8] | `magic` | ASCII `"SIGBLK01"`. Identifies the format with no extension or registry. |
| 8 | 2 | u16 | `formatVersion` | `1` |
| 10 | 2 | u16 | `headerBytes` | `4096`. **Seek to this for block 0 — never hard-code 4096.** |
| 12 | 4 | u32 | `endianness` | `0x01020304` written in file order. Read as LE: `0x01020304` ⇒ file is LE; `0x04030201` ⇒ file is BE and every field must be byte-swapped. |
| 16 | 16 | u8[16] | `recordingId` | UUIDv4, binary. Ties file ↔ sidecar unambiguously. |
| 32 | 4 | u32 | `channelCount` | e.g. `32` |
| 36 | 4 | u32 | `sampleRateHz` | integer Hz, e.g. `4000` |
| 40 | 8 | f64 | `sampleRateExactHz` | For non-integer rates. **Readers SHOULD prefer this.** |
| 48 | 2 | u16 | `dtypeCode` | `1`=float32LE, `2`=float64LE, `3`=int16LE, `4`=int32LE |
| 50 | 2 | u16 | `bytesPerValue` | `4`. Redundant with `dtypeCode` **by design**: a reader that does not know a future `dtypeCode` can still compute layout and skip correctly. |
| 52 | 4 | u32 | `layoutCode` | `1` = `BLOCK_PLANAR` (§4). `2` = `BLOCK_INTERLEAVED`, reserved. |
| 56 | 4 | u32 | `framesPerBlock` | `4000` — the **nominal** count. Any block may carry fewer; its own header says so. |
| 60 | 4 | u32 | `blockHeaderBytes` | `64` |
| 64 | 8 | u64 | `blockStrideBytes` | `512064` = `blockHeaderBytes + framesPerBlock*channelCount*bytesPerValue`. **The single number an O(1) seek needs.** |
| 72 | 8 | u64 | `totalFrames` | Valid **iff** `FINALISED`; otherwise `0` and the reader reconstructs (§6). |
| 80 | 8 | u64 | `totalValues` | `totalFrames * channelCount` |
| 88 | 8 | u64 | `blockCount` | Valid iff `FINALISED` |
| 96 | 8 | f64 | `durationSeconds` | `totalFrames / sampleRateExactHz` |
| 104 | 8 | u64 | `startTimestampUnixNanos` | Wall clock at `frameIndex 0` |
| 112 | 8 | u64 | `endTimestampUnixNanos` | Set at finalisation; `0` otherwise |
| 120 | 8 | u64 | `startMonotonicNanos` | Monotonic clock at `frameIndex 0`. Pairs with per-block timestamps for jitter forensics. |
| 128 | 8 | u64 | `trailerOffset` | Byte offset of the trailer; `0` if absent |
| 136 | 4 | u32 | `trailerBytes` | |
| 140 | 4 | u32 | `flags` | See below |
| 144 | 8 | u64 | `droppedFramesTotal` | Quick answer without parsing the trailer |
| 152 | 4 | u32 | `ledgerEntryCount` | |
| 156 | 4 | u32 | `ringBytes` | Recorder ring size used — the recording documents its own buffering policy |
| 160 | 4 | u32 | `fsyncIntervalSeconds` | Bounds the data-at-risk window for a non-finalised file |
| 164 | 4 | u32 | `generatorTickNanos` | e.g. `5000000` |
| 168 | 32 | char[32] | `signalId` | NUL-padded ASCII, e.g. `"tri+saw+hash32/v1"`. Names the deterministic formula so a validator can **refuse** a file it cannot reproduce. |
| 200 | 64 | char[64] | `producer` | e.g. `"sigacq 1.0.0 node-v24.15.0 darwin-arm64"` |
| 264 | 256 | char[256] | `description` | Free text |
| 520 | 3,572 | u8[] | `reserved` | MUST be zero on write; readers MUST ignore |
| 4092 | 4 | u32 | `headerCrc32c` | CRC-32C over bytes `[0, 4092)`. Detects a torn header. |

### Header flags (offset 140)

| Bit | Name | Meaning |
|---:|---|---|
| 0 | `FINALISED` | The run ended cleanly. `totalFrames` / `blockCount` / `endTimestamp` are trustworthy. |
| 1 | `HAS_TRAILER` | `trailerOffset` / `trailerBytes` are valid |
| 2 | `HAD_DROPS` | At least one range of frames was lost. **Seek must use the §5.2 fallback.** |
| 3 | `LEDGER_TRUNCATED` | Drop counts are exact; the *enumeration of positions* was capped |
| 4 | `DITHER_DISABLED` | The signal was generated without its dither term |

---

## 3. Block header — exactly 64 bytes, at the start of every block

| Off | Size | Type | Field | Notes |
|---:|---:|---|---|---|
| 0 | 4 | u32 | `blockMagic` | `0x424C4B42` (ASCII `"BLKB"`). Allows resynchronisation in a damaged file. |
| 4 | 8 | u64 | `startFrameIndex` | **Absolute.** NOT `blockIndex * framesPerBlock` — that would be false after a drop. |
| 12 | 4 | u32 | `frameCount` | Frames actually present. `<= framesPerBlock`. |
| 16 | 4 | u32 | `payloadBytes` | `frameCount * channelCount * bytesPerValue` |
| 20 | 8 | u64 | `blockIndex` | Position in the file. `startFrameIndex != blockIndex*framesPerBlock` ⇒ a drop occurred earlier. |
| 28 | 8 | u64 | `monotonicNanos` | Recorder's monotonic clock when the block was assembled |
| 36 | 4 | u32 | `flags` | bit0 `SHORT_BLOCK`, bit1 `PRECEDED_BY_GAP` |
| 40 | 4 | u32 | `precedingGapFrames` | Frames missing immediately before this block. **A reader can rebuild the entire drop ledger from block headers alone.** |
| 44 | 12 | u8[12] | `reserved` | zero |
| 56 | 4 | u32 | `payloadCrc32c` | CRC-32C over the payload's `payloadBytes` |
| 60 | 4 | u32 | `headerCrc32c` | CRC-32C over bytes `[0, 60)` of this header |

Every block is **independently valid**: it carries its own absolute position, its own length, and two
checksums. A block can be verified without reference to the header's totals or to any other block.

**Block b begins at `headerBytes + b * blockStrideBytes`.** A short block still consumes a full
stride; the bytes between `blockHeaderBytes + payloadBytes` and `blockStrideBytes` are undefined and
MUST NOT be read.

---

## 4. Payload layout — `BLOCK_PLANAR` (`layoutCode == 1`)

Frames are chunked into blocks; **within a block, data is channel-major (planar)**:

```
Block payload (512,000 B at defaults):
┌──────────────────────┬──────────────────────┬─────┬──────────────────────┐
│ ch0: frameCount vals │ ch1: frameCount vals │ ... │ chC-1: frameCount    │
│ 16,000 B             │ 16,000 B             │     │ 16,000 B             │
└──────────────────────┴──────────────────────┴─────┴──────────────────────┘
offset 0                offset 16,000                offset 496,000
```

The value for **channel `c`, frame `startFrameIndex + j`** lives at byte offset:

```
blockStart  = headerBytes + blockIndex * blockStrideBytes
valueOffset = blockStart + blockHeaderBytes
            + c * frameCount * bytesPerValue
            + j * bytesPerValue
```

> **Note the stride is `frameCount`, not `framesPerBlock`.** In a short block, channel runs are
> shorter. Using `framesPerBlock` here is the most likely mistake an independent implementer will
> make, and it silently returns data from the wrong channel.

**Why planar-within-a-chunk.** A `k`-of-`C` channel subset reads `k/C` of the payload in `k`
contiguous runs, rather than touching every byte as a frame-interleaved layout would. The trade
accepted: reading a single *frame* across all channels costs `C` scattered reads instead of one.

---

## 5. Reading

### 5.1 Seek — O(1) in the nominal case

```
frameIndex f  (or time t: f = floor(t * sampleRateExactHz))
blockIndex  = floor(f / framesPerBlock)
blockOffset = headerBytes + blockIndex * blockStrideBytes
```

**Cost: one 64-byte read.** No index, no scan, no dependence on file size.

### 5.2 Seek when `HAD_DROPS` is set

The mapping above assumes `startFrameIndex == blockIndex * framesPerBlock`, which holds only if no
frames were lost. When `flags & HAD_DROPS`:

1. Compute the closed-form guess and read that block's header.
2. If `startFrameIndex <= f < startFrameIndex + frameCount`, done — the guess was right.
3. Otherwise **binary-search over block headers**. `startFrameIndex` is guaranteed monotonically
   increasing across blocks, so this is valid. Cost: `ceil(log2(blockCount))` 64-byte reads —
   12 reads (768 B) for a one-hour file.

A drop-free file never pays for step 3, because the guess is checked before the search begins.

### 5.3 Channel-subset read cost

For `k` of `C` channels over `F` frames spanning `B` blocks:

```
bytesRead    = B * blockHeaderBytes + k * F * bytesPerValue
readCalls    = B * (1 + k)
```

Worked example — channels {3, 17} over 60 s of a 1 h file at defaults:

| | bytes |
|---|---:|
| 2 of 32 channels | 1,955,904 (1.87 MiB) |
| all 32 channels | 31,235,904 (29.8 MiB) |
| **saving** | **15.97x** — matching `C/k = 16` |

---

## 6. Truncated and non-finalised files

**A truncated file is fully readable up to the truncation point.** Four properties make this true:

1. the header is fixed-size and written **first**, so parameters exist from byte 0 of any file longer
   than 4,096 bytes;
2. `blockStrideBytes` is constant, so the block count is **computed**, never scanned for;
3. each block carries its own position, length and two CRCs, so it is valid independently;
4. the `FINALISED` flag says which path to take.

```
if (flags & FINALISED) and blockCount is consistent with the file length:
    totalFrames = header.totalFrames                      # trust the header
else:
    n = floor((fileSize - headerBytes) / blockStrideBytes)
    while n > 0:
        h = read block header (n - 1)
        if h.blockMagic == "BLKB" and h.headerCrc32c verifies:
            totalFrames = h.startFrameIndex + h.frameCount
            break
        n -= 1                                            # discard the torn tail block
    # any partial bytes after the last full block are ignored
```

A finalised file's last block may legitimately be short, so `blockCount` may exceed the whole-stride
count by exactly one; accept that only if the last block's own header verifies.

**Loss on an unclean kill is bounded by `framesPerBlock` — one second at defaults.** Data is at risk
for at most `fsyncIntervalSeconds` (header offset 160).

> Reading a file that is **still being written** uses this identical path. That is deliberate: the
> crash-recovery code is exercised continuously by the live viewer rather than being untested
> crash-only code.

---

## 7. Trailer — the drop ledger

Present iff `flags & HAS_TRAILER`. Located at `trailerOffset`, length `trailerBytes`.

```
offset 0    8 B    char[8]   magic  = "SIGTRLR1"
offset 8    4 B    u32       entryCount
offset 12   24 B x entryCount:
                     0   8 B  u64   startFrameIndex
                     8   8 B  u64   frameCount
                    16   4 B  u32   causeCode
                    20   4 B  u32   reserved (zero)
then        4 B    u32       crc32c over bytes [0, 12 + entryCount*24)
then        8 B    char[8]   magic repeated = "SIGTRLR1"
```

The magic is **repeated at the end** so the trailer can be found by scanning backward from EOF when
the header was never finalised.

| `causeCode` | Name | Meaning |
|---:|---|---|
| 1 | `GENERATOR_RING_FULL` | Producer's bounded buffer overflowed — consumer stalled beyond the absorption window |
| 2 | `RECORDER_RING_FULL` | Recorder's bounded buffer overflowed — write path stalled beyond its window |
| 3 | `PACING_RESYNC` | The producer fell so far behind wall-clock that catching up was abandoned |
| 4 | `TRANSPORT_GAP` | A gap observed in the delivered frame sequence |
| 5 | `CORRUPT_FRAMES` | Frames discarded after a checksum failure |
| 6 | `GENERATOR_DISCONNECT` | Producer disconnected |

**The trailer is a convenience and a cross-check, not load-bearing.** The same information is
derivable from block headers alone: wherever `block[i].startFrameIndex >
block[i-1].startFrameIndex + block[i-1].frameCount`, the difference is a gap, and
`precedingGapFrames` states it directly.

---

## 8. CRC-32C

Castagnoli polynomial, **reflected form `0x82F63B78`**, init `0xFFFFFFFF`, final XOR `0xFFFFFFFF`,
input and output reflected. This is the same CRC used by iSCSI, ext4 and SCTP.

Check value: `CRC32C("123456789") == 0xE3069283`. An implementation that reproduces this value is
correct.

```python
TABLE = []
for i in range(256):
    crc = i
    for _ in range(8):
        crc = (crc >> 1) ^ (0x82F63B78 if crc & 1 else 0)
    TABLE.append(crc)

def crc32c(data, crc=0xFFFFFFFF):
    for b in data:
        crc = (crc >> 8) ^ TABLE[(crc ^ b) & 0xFF]
    return crc ^ 0xFFFFFFFF
```

---

## 9. Sidecar JSON

`<stem>.json` sits beside `<stem>.sigb`. **The embedded header is authoritative.** The sidecar adds
what does not belong in a fixed binary schema: full configuration with the provenance of every value,
pacing statistics, and the drop ledger in both frame- and value-indexed form.

Association is verifiable three independent ways:

1. **filename stem** — `run-X.sigb` ↔ `run-X.json`;
2. **`recordingId`** — the same UUID appears at header offset 16 (binary) and as `"recordingId"` in
   the JSON. A reader **MUST** verify these match and **MUST** warn loudly if not;
3. **`binaryFile`, `binarySizeBytes`, `headerCrc32c`** in the JSON identify the exact artifact.

**Conflict rule: if the sidecar and the embedded header disagree, the embedded header wins and the
reader emits a warning.** Ambiguity is resolved by written policy, not by luck.

---

## 10. Minimal reader checklist

1. Read 4,096 bytes. Check `magic == "SIGBLK01"`, verify `headerCrc32c`, check `endianness`, check
   `formatVersion`.
2. Read `channelCount`, `sampleRateExactHz`, `dtypeCode`, `bytesPerValue`, `layoutCode`,
   `framesPerBlock`, `blockHeaderBytes`, `blockStrideBytes`, `headerBytes`.
3. Determine the extent: trust `totalFrames` if `FINALISED` and consistent, else recover per §6.
4. For a target frame, compute the block per §5.1 (or §5.2 if `HAD_DROPS`).
5. Read that block's 64-byte header; verify `blockMagic` and `headerCrc32c`.
6. Read only the channel runs wanted, at `blockStart + blockHeaderBytes + c*frameCount*bytesPerValue`.
7. Optionally verify `payloadCrc32c` over the whole payload.
