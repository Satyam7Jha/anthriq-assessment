# sigacq — continuous multi-channel biosignal acquisition, recording, retrieval and playback

A 32-channel, 4,000 Hz acquisition pipeline in Node.js and React: a deterministic signal generated in
one process, streamed to a separate recorder process over a Unix domain socket, persisted to a
self-describing binary format with zero sample loss and flat memory, and retrievable, replayable and
verifiable afterwards. Plus a biosignal review viewer that renders it without ever being able to
touch the acquisition path.

**Platform developed and measured on:** macOS 26.5 (Darwin 25.5.0), Apple Silicon, Node.js v24.15.0.
**Runtime dependencies: zero.** The acquisition, storage, retrieval and verification paths import
nothing outside the Node standard library. Build-time dependencies (esbuild, TypeScript, Tailwind,
React) exist only for the front-end bundle, which is committed — so `npm install` is not required to
run any of the graded functionality.

---

## Headline results

All measured on the target machine. Method and raw artifacts in [Measured performance](#measured-performance).

| Claim | Measured |
|---|---|
| Sample loss over a sustained run **with the viewer attached throughout** | **0** — validator `PASS`, exit 0 |
| Generator pacing deviation | **14 frames in 1,086,560 = 12.9 ppm** (3.5 ms over 4.5 min) |
| Tick lag | **p50 ≤ 16 µs, p99 ≤ 32 µs**, 3 late ticks in 54,328 |
| Recorder memory | **127.2 MiB, flat** — every allocation happens before the first byte is accepted |
| Ring-buffer peak utilisation | **0.76 %** of a 131-second absorption window |
| Generator pacing while the recorder is **SIGSTOPped for 10 s** | **unchanged** — deviation stays within one tick, 0 resyncs |
| Validator throughput / memory | **97.2 M values/s**, **60.5 MiB constant** regardless of file size |
| Channel-subset read, 2 of 32 | **15.97× fewer bytes**, measured == closed-form prediction exactly |
| Seek cost | **1 pread, 64 bytes, ~11 µs**, O(1) |
| Independent Python reader written from the spec alone | **identical values to 9 decimals**, 272/272 blocks verified |
| Slow disk, 1.5 s per write into a 1 MiB ring | loss reported as **751,360 missing, 0 incorrect**, ledger agrees, file finalised |

---

## Quick start

### Everything at once

```bash
npm install && npm run ui:build && npm run demo
```

Starts the recorder, the generator and the viewer as three separate processes, prints
`http://localhost:8787`, and records until you press Ctrl-C (or for the duration you pass:
`npm run demo -- 600`). On exit it shuts the recorder down through the clean-shutdown path — finalising
the header, writing the trailer and sidecar — and then validates what was recorded:

```
  recorder — final report
    frames               100,000  =  3,200,000 values
    ring peak            0.76% of 64.0000 MiB (131.1 s capacity)
    dropped              0 frames in 0 range(s)
    finalised            yes

  ── verification ─────────────────────────────────────────
Expected: 3,200,000 samples
Recorded: 3,200,000 samples
Missing:   0
Duplicated: 0
Incorrect:  0
Result: PASS
  exit status: 0
```

`npm install` and `npm run ui:build` are only needed for the **viewer**. The acquisition, storage,
retrieval and verification paths below run on a bare checkout with no install step.

### Or run the processes yourself

```bash
# 1. Recorder first — it owns the socket and the file.
node bin/recorder.js --out /tmp/run.sigb --stats-interval 5
```

```bash
# 2. Generator, in a second terminal. Two genuinely independent processes.
node bin/generator.js --duration 60
```

```bash
# 3. Ctrl-C the recorder to finalise, then verify. Exit status is the machine-checkable result.
node bin/sigval.js /tmp/run.sigb; echo "exit=$?"
```

```
Expected: 34,769,920 samples
Recorded: 34,769,920 samples
Missing:   0
Duplicated: 0
Incorrect:  0
Result: PASS
```

```bash
# 4. Inspect, retrieve, and view.
node bin/sigctl.js info /tmp/run.sigb
node bin/sigctl.js read /tmp/run.sigb --from 10s --to 12s --channels 3,17
npm install && npm run ui:build && node bin/uiserver.js --follow /tmp/run.sigb   # then open :8787
```

---

## Architecture

```
                        ACQUISITION HOT PATH — two processes, nothing else touches it
 ┌──────────────────────────┐    AF_UNIX SOCK_STREAM     ┌──────────────────────────────┐
 │ PROCESS A: generator     │    518,400 B/s             │ PROCESS B: recorder          │
 │                          │ ═════════════════════════▶ │                              │
 │  deadline scheduler      │    wire blocks, 20 frames  │  framing + CRC + gap detect  │
 │  (monotonic clock)       │                            │  BOUNDED RING 64 MiB (131 s) │
 │  closed-form signal      │                            │  transpose → planar          │
 │  BOUNDED RING 2.5 MiB    │                            │  ≤ 1 write in flight         │
 │  drop-oldest + ledger    │                            │  drop-newest + ledger        │
 └──────────────────────────┘                            └───────────────┬──────────────┘
                                                                         ▼
                                                          run.sigb  +  run.json
        ─── PROCESS BOUNDARY: everything below opens the file O_RDONLY ───┬───
                    ┌───────────────┬────────────────┬───────────────────┴──┐
                    ▼               ▼                ▼                      ▼
              sigctl (C)          sigval (C)                  uiserver (E) → React
           info/read/seek         validator                   binary frames, pulled
```

**Why the boundaries sit here.**

- **A ↔ B is a socket** because the assessment requires two processes, and because it is genuinely
  the right split: generator pacing is a real-time concern and recorder I/O is a throughput concern,
  and separate event loops mean a recorder GC pause or disk stall cannot preempt the generator's
  timer.
- **B ↔ everything else is the filesystem, with no IPC at all.** The recording is the contract.
  Readers open it `O_RDONLY` and use positional reads, so they hold no shared state with the
  recorder, cannot block it, and cannot corrupt it. This is what makes "the viewer does not degrade
  acquisition" true **structurally** rather than by measurement.
- The recorder is the **server** and the generator the **client**, because the recorder owns the
  durable resource. The generator can crash and reconnect without closing the recording, and the
  reconnect surfaces as a gap at an exact position.

---

## How the generator stays on time when the recorder does not

This is the hardest requirement in the brief — *"a slow or stalled consumer must not make the
generator fall behind"* — and it is satisfied by three layered mechanisms, not one.

**1. Absolute deadlines against a monotonic clock.** The scheduler computes

```
emittedFrames(k) = k · FRAMES_PER_TICK          deadline(k) = t0 + k · TICK_NS
```

Both are pure functions of the tick counter. Because the next deadline is never computed from "now",
**drift cannot accumulate by construction**: a tick that runs 3 ms late does not move the next
deadline, it merely leaves less slack. `setInterval(fn, 5)` would instead compound ~1 ms of libuv
timer quantisation into a running sum — roughly **6 minutes of drift per hour**, a ~10 % sample
shortfall. That is not a subtle effect; it is total failure of the primary requirement.

Since macOS timer granularity is ~1 ms, the scheduler deliberately wakes **one millisecond early**
and closes the last gap with `setImmediate` hops, so tick jitter is bounded by one event-loop turn
rather than by timer resolution.

**2. The tick never awaits anything.** It never awaits a `'drain'` event, never awaits a promise, and
never inspects whether the recorder is healthy. Its runtime is a pure function of CPU cost — measured
at **1.04 ms of signal generation per second of data, ~0.1 % of one core**.

**3. Bounded buffering with positioned, accounted loss.** A preallocated 2.5 MiB ring absorbs ~5 s of
consumer stall. Before every write the drain loop checks `socket.writableLength`, so Node's
internally *unbounded* `Writable` queue can never become a second hidden buffer. When the ring fills,
the oldest block is dropped and its exact `(startFrameIndex, frameCount)` goes into a ledger.

### The evidence

`node bench/stalled-consumer.mjs --stall 10` runs the pair to steady state, **SIGSTOPs the recorder
for ten seconds** — a total consumer stall, the process is not scheduled at all — and watches the
generator:

```
  t=10s  >>> SIGSTOP recorder
    +1s  deviation   20 frames  ring      0%  dropped       0
    +4s  deviation   20 frames  ring  19.63%  dropped       0
    +8s  deviation   20 frames  ring  97.75%  dropped       0
    +9s  deviation   20 frames  ring    100%  dropped    3540
   +10s  deviation   20 frames  ring    100%  dropped    7540
  >>> SIGCONT

  ok  generator never fell behind (deviation stays within one tick)
  ok  deviation during the stall stays within one tick
  ok  no pacing resync was needed
  ok  every dropped range carries a start position
  ok  no delivered value was incorrect
  ok  no value was duplicated
  ok  recorder and validator agree on the missing count
```

The deviation is **constant at 20 frames — exactly one tick — before, during and after the stall**.
The generator is at most one tick *ahead* (it emits the tick whose deadline has arrived) and never
behind. Buffers fill in a straight line at the predicted rate and loss begins only when the ring is
genuinely exhausted, which is what makes the bound a *designed* bound rather than an accident.

The last check is the one worth dwelling on. The recorder logs the ranges it knows it lost. The
validator, separately, derives gaps **from block headers alone**, with no access to that ledger. They
agree exactly — 365,440 values, same two ranges, same positions. Two independent derivations of the
same fact.

---

## The deterministic signal, and the trap it avoids

The validator recomputes the expected signal and compares **bit patterns**. That only works if the
signal is bit-reproducible, and there is a trap here that would silently sink the whole submission:

> ECMAScript specifies `Math.sin`, `cos`, `exp`, `pow` and `log` only as
> **"implementation-approximated"**. V8 has changed its `Math.sin` implementation historically, and
> nothing guarantees identical results across V8 versions or architectures.

**Any sine-based waveform is therefore not reproducibly bit-exact**, and a validator recomputing it
under a different Node build could report spurious `Incorrect` counts. The waveform is built
**exclusively** from operations IEEE-754 requires to be correctly rounded and that ECMAScript
inherits verbatim: `+ - * / %`, `Math.abs`, `Math.fround`, and 32-bit integer operations. No
transcendental function appears anywhere in the signal path.

```js
value(c, n) = fround( a1·triangle(n·k1 mod 2^16)      // per-channel frequency and amplitude
                    + 0.25·sawtooth(n·k2 + phase)      // a decorrelated second component
                    + 0.03125·(hash32(c,n)/2^32 - 0.5) // deterministic dither
                    + c/32 )                           // per-channel DC offset
```

The dither is not noise in the non-deterministic sense — `hash32` is a pure function of `(c, n)`. Its
job is to make the float32 mantissa non-trivial, so a validator bug that compared only the high bits
could not pass by accident.

| Property | Measured |
|---|---|
| Bit-exact across 2,000,000 recomputes | **0 mismatches** |
| Order-independent (forward, reverse, random access) | identical |
| Channels distinguishable | 32/32 distinct means, 32/32 distinct at a fixed instant |
| Value range | `[-0.5951497554779053, 2.17848801612854]` |
| Integer safety at 100 hours | `Number.isSafeInteger(4000·3600·100·63)` ⇒ true |
| Cost | **1.04 ms per 128,000 values** = 0.10 % of one core |

Comparison is done on bit patterns rather than `===`, which sidesteps the two ways `===` misleads on
floats: `NaN !== NaN` would under-report a difference and `-0 === +0` would over-accept one. This
signal produces neither, but the comparison is written to be correct regardless — *the validator
being itself correct* is a graded property.

---

## Storage format

Full specification: **[`docs/FORMAT.md`](docs/FORMAT.md)** — complete enough that
`tools/independent_reader.py` was written from it alone.

```
┌──────────────┬──────────────┬──────────────┬─────┬──────────────┬───────────┐
│  HEADER      │  BLOCK 0     │  BLOCK 1     │ ... │  BLOCK N-1   │  TRAILER  │
│  4,096 B     │  512,064 B   │  512,064 B   │     │  ≤512,064 B  │  ledger   │
└──────────────┴──────────────┴──────────────┴─────┴──────────────┴───────────┘
```

- **Self-describing 4,096-byte header** carries everything the brief demands — channel count, sample
  rate, total sample count, duration, dtype/width/byte order, interleaving scheme, start timestamp —
  plus the recording's own buffering policy, so a file documents the conditions it was made under.
- **Chunked-columnar payload**: frames are chunked into 1-second blocks, and within a block the data
  is channel-major. A `k`-of-`C` subset therefore reads `k/C` of the payload in `k` contiguous runs.
- **Every block is independently valid** — its own absolute `startFrameIndex` (not
  `blockIndex × framesPerBlock`, which would be false after a drop), its own `frameCount`, and two
  CRC-32Cs.
- **Every block occupies exactly `blockStrideBytes`**, short ones included. That invariant is what
  makes seeking closed-form; a mid-file block that occupied fewer bytes would silently invalidate
  every offset after it.

### Numeric representation: 4 bytes per value (float32)

| Type | B/value | 1 h file | Verdict |
|---|---:|---:|---|
| int16 | 2 | 0.858 GiB | Rejected — halves the file but inserts a lossy quantisation step between "expected signal" and "recorded value", forcing the validator into tolerance comparison. |
| **float32** | **4** | **1.7168 GiB** | **Chosen** — matches the natural precision of the source exactly, needs no scale/offset metadata. |
| float64 | 8 | 3.434 GiB | Rejected — doubles I/O to store rounding noise; the carrier terms have ≤16 fractional bits and are already exact in float32. |

**What real biosignal hardware actually emits, and why this departs from it.** Real ExG front ends —
the TI **ADS1299** family, which sits behind essentially every research and clinical EEG amplifier —
emit **signed 24-bit integers**, three bytes per channel per sample over SPI. That is the entire
reason **BDF** exists: EDF's 16 bits throw away most of an ADS1299's range. 32 channels at 4 kHz is a
plausible montage rather than an arbitrary number — roughly four ADS1299s ganged on a shared SPI bus,
which is how a 32-channel amplifier is actually built.

This system stores float32 anyway because **the precision of the storage should match the precision
of the source, and here the source is a closed-form float function, not an ADC**. Storing it as int24
would *introduce* a quantisation step with no physical counterpart, and that step would propagate
straight into the validator. The format is already prepared for the alternative: `dtypeCode` and
`bytesPerValue` are independent fields precisely so a 3-byte type is expressible, and `layoutCode` is
a field rather than an assumption. See `PLAN.md` §5.5 for what would change with a real front end.

### Alternatives considered

The clinical and research formats are engaged properly in `PLAN.md` §8.8; the short version:

| Failure mode | Formats |
|---|---|
| Header/footer finalised **at close** ⇒ an interrupted file is not self-describing | EDF, EDF+, BDF, GDF, Parquet, HDF5, NPY |
| **Lossy integer quantisation** ⇒ exact validation impossible | EDF, EDF+, BDF |
| **Mandatory interleaving** ⇒ 32× read amplification for one channel | WAV, RF64/BW64 |
| Size, parse cost, or float round-tripping | CSV, JSONL, OpenBCI text |
| Native dependency | HDF5, SQLite, liblsl |
| Not specifiable in four pages | MNE/FIF |

The honest summary is not that the standards are bad — it is that **the clinical formats are
optimised for archival interchange of a completed session, while this assessment grades the behaviour
of a recording that is still being written.** Every property that makes EDF a good interchange format
(fixed records, a header describing the whole file, integer samples with a documented physical scale)
is the property that fails here. Notably, the layout this design arrives at independently — planar
within a chunk — is the same layout EDF uses inside a data record, which is a reassuring convergence
rather than a coincidence.

**Lab Streaming Layer** is a transport rather than a format, and is the right answer for a
multi-device, multi-host montage where clock offsets between acquisition boxes must be estimated. It
is rejected here because its central value solves a problem that does not exist between two processes
sharing one `mach_absolute_time` clock, and because its overflow semantics are a silent drop of
oldest samples, whereas this brief requires the **position** of every loss.

### Behaviour under interruption

**A truncated file is fully readable up to the truncation point.** The header is fixed-size and
written first; `blockStrideBytes` is constant so the block count is computed rather than scanned for;
each block is independently verifiable; and the `FINALISED` flag tells a reader which path to take.

On an unclean kill, loss is bounded by one block — **1.0 second** — and data at risk is bounded by
`fsyncIntervalSeconds`, which is recorded in the header. The validator reports such a file as
`PASS (TRUNCATED)` with **exit code 2**, so a script can distinguish "the recorder lost data" from "I
hit Ctrl-C" from "you handed me a JPEG".

Reading a file that is **still being written uses this identical path**, which means the
crash-recovery code is exercised continuously by the live viewer rather than being untested
crash-only code. The screenshot in [the viewer section](#the-front-end) shows the validator invoked
against a live file returning exactly that verdict.

### Arithmetic (verified)

```
bytes/value                     4            (float32)
bytes/second                    512,000
file block on disk              512,064 B    (512,000 payload + 64 header)
blocks in one hour              3,600
one-hour recording              1,843,434,496 B  =  1.7168 GiB
metadata overhead               0.0127 %
values in one hour              460,800,000   ✓ matches the brief
```

---

## Verification

```bash
node bin/sigval.js FILE.sigb            # 0 PASS · 1 FAIL · 2 PASS(TRUNCATED) · 3 UNREADABLE
```

Single streaming pass, **O(1) memory**: one reused block buffer, one 64-byte header buffer, a 4-byte
scratch, and a dozen counters. Neither the recording nor the expected signal is ever materialised —
the expected signal is recomputed one value at a time from the closed-form function. Measured at
**97.2 M values/s with 60.5 MiB peak RSS**, constant regardless of file size; a one-hour recording
validates in about five seconds.

`Missing` is derived from **sequence gaps**, not from `Expected − Recorded`, because those two can
legitimately disagree (duplicates inflate `Recorded`) and reporting both makes the discrepancy itself
a signal.

A **fourth class, `Corrupt`**, is reported beyond what the brief asks for, and only when non-zero so
the nominal output still matches the required format byte-for-byte. Without it a bit-rotted block
would be reported as 128,000 "incorrect values" — technically true and diagnostically useless.

### The validator is demonstrated failing

An always-PASS validator is indistinguishable from `exit 0`. `bench/corrupt.mjs` damages a good
recording four ways and asserts the class, the count **and the first position** of each:

```
  MISSING — one whole block spliced out              ok  exit 1, 128,000 missing, first at value #256,000
  DUPLICATED — one block written twice               ok  exit 1, 128,000 duplicated, first at value #128,000
  INCORRECT — one value altered, block CRC REPAIRED  ok  exit 1, exactly 1 incorrect, ch7 frame 12,123,
                                                         byte offset 1,652,844
  CORRUPT — a byte flipped, CRC left stale           ok  exit 1, 128,000 corrupt, 0 incorrect
  CONTROL — the unmodified file                      ok  exit 0, PASS

  ALL CHECKS PASSED
```

The `INCORRECT` case repairs the block CRC deliberately, so the damage cannot hide behind a checksum
failure. That is the case a checksum *cannot* catch, and the reason the value comparison exists.

---

## Retrieval and playback

```bash
node bin/sigctl.js info  FILE.sigb                                   # metadata
node bin/sigctl.js read  FILE.sigb --from 10s --to 12s --channels 3,17 --out csv
node bin/sigctl.js read  FILE.sigb --from "#400000" --to "1:30" --channels 0-7
node bin/sigctl.js seek  FILE.sigb --at 0s,2.5s,600s                 # measured seek cost
```

Positions are addressable by **time or sample index** — `12.5s`, `#50000`, `1:30`, `250ms`.

**Seek is O(1):** `blockIndex = floor(f / framesPerBlock)`, one 64-byte read, measured at **~11 µs**.
When a recording *has* drops that mapping is no longer exact, so the reader falls back to a binary
search over block headers — `log₂(3600) ≈ 12` reads, 768 bytes for a one-hour file. The drop-free case
never pays for it, because the closed-form guess is checked before the search begins.

**Channel-subset reads touch only what they need,** and the claim is checked rather than asserted —
every `fs.read` is counted and compared against the closed-form prediction:

```
  channels       2 of 32  [3,17]
  bytes read     128,256   in 12 read calls
  predicted      128,256   (§9.2 closed form)  MATCHES
  all-channel    2,048,256                 =>  15.97x fewer bytes read
  subset ratio   6.25%  (k/C = 6.25%)
```

**Memory during retrieval is `blockHeaderBytes + k × framesPerBlock × bytesPerValue`** — 32 KB for two
channels, 512 KB for all 32 — **independent of file size**. Reading a 41 GiB 24-hour recording uses
the same 512 KB as reading a 10-second one.

**Playback** (play, pause, resume, seek, 0.25×–8×) is driven from the viewer. The cursor is computed
from the **monotonic** clock — `anchorFrame + elapsed × rate × multiplier` — and pause, resume and seek
re-anchor it, which is the deliberate difference between playback, where elapsed paused time is *not*
owed, and acquisition, where it is. Position is always an exact integer frame index.

This is honestly simpler than acquisition pacing: the viewer only needs the right position twenty
times a second, not a sample-accurate output stream, so it does not run on the generator's deadline
scheduler. An earlier version of this README claimed it did; that was not true, and an external review
caught it.

---

## The front end

React 19 + TypeScript + Tailwind 4, built with esbuild into a committed static bundle.

The brief files the visualizer under "optional" and says visual polish is not assessed. It is built as
a first-class deliverable anyway, for an architectural reason rather than a cosmetic one: **the
properties this system is graded on — pacing accuracy, bounded buffering, positioned loss, O(1) seek,
channel-subset economy — are all invisible in a terminal.** The front end is the surface that makes
them legible in two seconds.

Two consequences for what got built.

**It is a recognisable instrument, not a generic chart.** The canonical view for multi-channel ExG is
a stacked column of per-channel traces sharing one time axis, with per-channel gain, a time base in
seconds-per-screen, and a montage selector. A single overlaid multi-series line chart would be the
tell that nobody looked at how this data is actually read.

**The interface is deliberately quiet, and ordered for a reviewer.** One trace view, one transport
bar, one inspector that answers questions in the order they get asked: *is the recording correct?*
(Verify, at the top), *what is it?* (Recording), *is acquisition healthy?* (Health), *how much am I
looking at?* (Channels shown: All · 16 · 8 · 4). Technical detail sits behind one disclosure. Rows
auto-fit their own range, so there is no scale control and a trace can never spill into its neighbour.
Three keys: Space plays or pauses, ← / → skip ten seconds. It follows the system light/dark setting,
and the only saturated colours are the accent, green and red — so lost samples or a failed
verification are the one thing on screen that draws the eye.

**The hard parts are kept hard, just out of sight:**

- **Zero React re-renders per frame.** Sample data lives in a ref outside the render cycle; the canvas
  reads it from a `requestAnimationFrame` loop, one `Path2D` per channel. Only low-frequency numbers
  go through state, at most four times a second.
- **Min/max envelope decimation, server-side.** At 4 kHz on a 1,000 px trace each pixel column covers
  40 samples. Subsampling shows a transient only if it lands on a sample point and averaging erases it;
  a min/max envelope means **a single-sample spike still extends its column and can never be hidden**.
- **Binary frames, pulled.** The browser asks for the next frame only after drawing the last one, and
  receives `[u32 length][JSON][float32 envelopes]`, read through a zero-copy `Float32Array` view — no
  base64, no per-byte decode, so nothing that needs a Worker. A slow tab simply asks less often; no
  backlog builds anywhere. (The first version pushed base64-in-JSON over SSE at ~7 MB/s and allocated
  fresh buffers on every push; the review was right about both.)
- **Channel selection changes what leaves the disk**, not what the browser draws: the reader issues
  `pread`s only for the selected channels, and the inspector footnote reports the saving and whether
  the measured byte count matches the closed-form prediction.
- **Lost samples are drawn, not just counted** — a soft red band across every row at the exact time.
- **Verification runs as a separate process**, and the verdict and exit code are shown as returned.

### It cannot affect acquisition, structurally

The UI server never connects to the acquisition socket and never talks to the recorder. It opens the
`.sigb` `O_RDONLY` and uses positional reads; it tails the recorder's stats NDJSON the same read-only
way. There is **no channel through which it could exert backpressure**. If the viewer is slow,
crashes, or is never started, the recording is bit-identical.

The price, stated plainly: **~1.1 s of display latency**, because the view follows committed file
blocks rather than the live socket. A lower-latency variant would need a second consumer on the
generator's write path, which is precisely the coupling the brief forbids.

The 4.5-minute run in the headline table had the viewer attached and rendering for its entire
duration, and still validated `PASS` with zero loss.

---

## Measured performance

**Method.** Every figure below comes from a run on the target machine, on AC power, via the committed
scripts named. Timing uses `process.hrtime.bigint()` (a monotonic clock, `CLOCK_UPTIME_RAW` on
Darwin); memory uses `process.memoryUsage.rss()` sampled by the recorder itself.

### Sustained acquisition — 271.6 s, 32 ch × 4,000 Hz, viewer attached throughout

```
recorder — final report                    generator — final pacing report
  size          139,285,528 B (132.8 MiB)    elapsed          271.637 s
  frames        1,086,560 = 34,769,920 vals  emitted          1,086,560 frames
  duration      271.640 s                    expected (clock) 1,086,546 frames
  blocks        272                          deviation        14 frames (12.885 ppm)
  ring peak     0.76% of 64 MiB (131.1 s)    tick lag         p50 ≤16 µs, p99 ≤32 µs, max 8,880 µs
  write latency max 2.68 ms                  late ticks       3 of 54,328
  fsyncs        27 (max 11.09 ms)            pacing resyncs   0
  gaps/dups     0 / 0 frames                 ring peak        2/1024 blocks (0.2%)
  crc failures  0                            drain stalls     0, peak socket queue 0 B
  dropped       0 frames in 0 ranges         dropped          0 frames
  finalised     yes
```

Note the distinction the numbers make. **Deviation** is a count identity that is near-exact by
construction; **jitter** is the real measured quantity. Reporting "12.9 ppm" without the tick-lag
histogram would be technically true and substantively misleading. The one 8.9 ms outlier is a single
scheduling excursion absorbed entirely by the deadline scheme — it cost zero frames, which is the
point.

### Memory

| Process | Measured | Grows with run duration? |
|---|---:|---|
| Recorder | **127.2 MiB** | **No** — 64 MiB ring + 2 × 512 KB block buffers + parser carry, all preallocated before the first byte is accepted |
| Validator | **60.5 MiB** | **No** — one block buffer regardless of a 132 MiB or 41 GiB input |
| Reader (32 ch) | 512 KB working set | **No** — scales with the window and subset, not the recording |

The drop ledger is bounded at 65,536 entries with adjacent-entry coalescing, because **an unbounded
ledger is itself memory proportional to elapsed time** — exactly what the brief rules out. If the cap
were ever reached, counts stay exact, only the enumeration of positions is capped, and the file says
so via a header flag.

### Component costs

| Operation | Measured |
|---|---|
| Signal generation | 1.04 ms per 128,000 values (0.10 % of one core) |
| CRC-32C | 0.99 ms per 518,400 B = **526 MB/s**; check value `0xE3069283` verified |
| Validation | 97.2 M values/s |
| Seek | ~11 µs, 1 pread, 64 B |
| Canvas draw | 0.90 ms/frame |

### Reproducing the evidence

```bash
npm test                                          # 25 tests: signal, scheduler, transport, recorder ingest
node bench/write-stall.mjs                         # slow disk: loss reported as MISSING, 0 incorrect
node bench/corrupt.mjs /tmp/run.sigb               # validator demonstrated FAILING, 4 classes
node bench/stalled-consumer.mjs --stall 10         # R11: SIGSTOP the recorder, 7 assertions
python3 tools/independent_reader.py FILE.sigb --check --channels 3,17 --from 100 --to 102 --dump 3
```

---

## Independent reader — the format spec proven, not claimed

The brief requires the format be documented well enough for a third party to write an independent
reader. `tools/independent_reader.py` **is** that third party: written from `docs/FORMAT.md` alone,
standard library only, importing nothing from `src/` and sharing no constant with the JavaScript
implementation. If it reads a recording correctly, the specification is sufficient.

```
  seek to frame 400,000: block 100, closed-form, 1 header read(s) = 64 B
  channels             [3, 17]  (2 of 32)
  bytes read           64,128
  all-channel equiv.   1,024,128   =>  15.97x fewer bytes read
    ch03  +0.124645039, +0.120716095, +0.141786873      ← Python, from the spec
    ch17  +0.000532358, +0.007596261, +0.002109939

  ch03   0.124645039,  0.120716095,  0.141786873        ← Node, from the implementation
  ch17   0.000532358,  0.007596261,  0.002109939

  blocks checked 272 · bad headers 0 · payload CRC fails 0 · gaps 0 · ledger AGREES
  INTEGRITY OK
```

---

## Configuration

Channel count and sample rate are runtime-configurable, never hard-coded. Resolution order, highest
priority first:

1. **CLI flags** — `--channels 8 --rate 1000`
2. **Environment** — `SIGACQ_CHANNELS=8 SIGACQ_RATE=1000`
3. **JSON file** — `--config path.json`, or `./sigacq.config.json` if present
4. **Built-in defaults** — `src/config/defaults.js`

Every resolved value carries its **source**, and both processes print it at startup, so "where did
this 4000 come from" never requires reading the code:

```
  channelCount           32                       [default]
  sampleRateHz           1000                     [env:SIGACQ_RATE]
  ringBytes              67108864                 [cli]
  derived                32,000 values/s, 128,000 B/s, block stride 128,064 B
```

Full option tables: `node bin/<tool>.js --help`.

---

## Design decisions and trade-offs accepted

| Decision | Trade-off accepted |
|---|---|
| **AF_UNIX socket** over shared memory | Gives up ~2,000× of headroom we do not need, to avoid a native addon and an unverifiable cross-process memory model. |
| **Drop-oldest** in the generator, **drop-newest** in the recorder | Opposite policies, deliberately. The generator's job is to stay on time and recency wins; the recorder's is to keep the file monotonic, and dropping from its tail would mean rewriting committed blocks. |
| **At most one write in flight** | Gives up pipelining so that the ring is the *only* queue. Free-running writes would make libuv's threadpool a second, unbounded, invisible buffer — and the watermark logic would be blind to it. |
| **Short blocks padded to a full stride** | Wastes up to one block per gap, to keep `blockStrideBytes` constant and seeking closed-form. |
| **fsync every 10 s**, not per block | Bounds data at risk to ~5 MB rather than putting an APFS stall into the write path 3,600 times an hour. The interval is in the header so a reader knows the window. |
| **float32** rather than int24 | Departs from real ADC hardware, to keep the validator's comparison exact rather than tolerance-based. Named explicitly rather than chosen silently. |
| **UI follows committed blocks** | ~1.1 s display latency, in exchange for the viewer being structurally incapable of affecting acquisition. |
| **Canvas 2D** rather than WebGL | Gives up ~10× of rendering headroom we do not need, to avoid shader code and context-loss recovery. Measured 0.90 ms/frame leaves ample room. |

### Bugs found during development, and how

Four real data-integrity bugs were found. The fault-injection harness caught three of them. The fourth,
and most serious, it missed — because the harness for that fault was specified in
`MEASUREMENT-PLAN.md` and never built. An external review built it and found the bug.

1. **A recorder-side drop silently mislabelled every later frame index** (found by external review).
   When the recorder's own ring overflowed, the dropped block had already advanced the wire parser,
   so the next block reported "no gap" and was appended to the open run. Every block after it carried
   a frame index short by the number of frames dropped — CRC-clean, self-consistent, and wrong. On a
   slow disk the validator reported *0 missing, 1,021,440 incorrect*. For an instrument that is worse
   than losing data: a gap is visible, a time shift is not. My stall test had only ever frozen the
   recorder process, so every drop happened upstream in the generator and took the path that worked.
   **Fix:** the ingest state machine now lives in `src/acquire/ingest.js`, measures every gap against
   the last frame it actually *accepted*, and is unit-tested with frames that carry their own index as
   their value. `bench/write-stall.mjs` reproduces the review's exact case and now reports
   **751,360 missing, 0 incorrect**, with the header ledger agreeing with the derived gaps.
2. **`net.Socket.write()` does not copy the Buffer it is given.** Handing it a view into a reusable ring
   meant the socket sent whatever the slot held *at flush time*; under a 10-second consumer stall this
   corrupted the stream. Fixed with a send-staging ring sized to exceed the maximum outstanding bytes;
   the platform behaviour is pinned by a regression test.
3. **Mid-file short blocks broke the constant-stride invariant**, invalidating every later offset.
   Blocks are now stride-padded.
4. **The writer's pending array was an unbounded second queue**, contradicting "the ring is the only
   queue". Replaced with one-pending plus a bounded segment list.

The same review found four smaller defects, all fixed: the shutdown watchdog was a fixed 1.5 s and on
a stalled disk killed the process before the ledger reached disk (shutdown now drains for a budget
scaled to observed write latency, then ledgers every unwritten frame by position and finalises
anyway); the validator ignored the drop count the file declares about itself (a recording whose
header and derived gaps disagree is now a FAIL, and `--json` carries `ledgerAgreesWithDerivedGaps`);
readers never checked `layoutCode` (unsupported layouts now exit 3); and the viewer's transport ran on
`Date.now()` (now monotonic).

Two more bugs were caught by the scheduler's fake-clock tests: emitting on a deliberately early wake,
and a `setTimeout(0)` spin that libuv clamps to 1 ms.

---

## Known limitations

- **Power-loss durability is not claimed.** `fsync(2)` on macOS does not flush the drive's write
  cache — only `F_FULLFSYNC` does, and Node does not expose it. The guarantee offered is that data
  reaches the OS, not the platter.
- **Big-endian files are detected and refused**, not byte-swapped. The header carries the marker and
  the spec documents the swap, but there is no BE platform in scope to produce or test one.
- **No DSP layer.** A real review tool has a 0.5–70 Hz band-pass, a 50/60 Hz notch, re-referencing and
  a spectrogram. All are genuinely useful and all are out of scope; the right place for them is a
  transform stage in the reader, not the browser.
- **There is no standalone `sigplay` process.** Playback lives in the viewer and is paced from the
  monotonic clock at display rate, not emitted as a sample-accurate stream; the prefetch pipeline in
  `PLAN.md` §9.4 is not built.
- **The viewer re-decimates its whole window on every frame** rather than caching envelopes per
  committed block. Buffers are reused, so this costs reads, not garbage — but a per-block cache is the
  right next step for many simultaneous viewers.
- **No physical units.** The header has no `vref`, per-channel gain or unit field, so values are
  dimensionless. The 3,572 reserved header bytes are where they belong.
- **The one-hour acceptance run and the duration-sweep memory regression** described in
  `MEASUREMENT-PLAN.md` §3 and §6 are specified but not yet executed; the longest run measured here is
  4.5 minutes. The memory argument currently rests on the *structural* claim (everything preallocated
  before ingest) plus a flat observed RSS, not on a slope with a confidence interval across a 240×
  duration range.
- **`--test-concurrency=1` is pinned** in `npm test`: the transport test holds a socket with megabytes
  queued, and running it concurrently with the timing tests made both flaky.

## Future work

- Execute the one-hour and 4-hour runs and report the RSS slope with a confidence interval.
- `sigctl export --format edf` — export a completed recording to EDF+ with explicit, documented
  per-channel `float32 → int16` scaling. Export at rest is the right place for a lossy interchange
  step; the acquisition path is the wrong place.
- An `int24` dtype (`dtypeCode 5`) with `vref`, per-channel `gain` and a `physicalUnit` header field,
  for a real ADS1299 front end — 25 % smaller files, and structural rather than value-based
  validation.
- Multi-device acquisition, where LSL's clock-offset model becomes the right prior art.
- Disk-full spill for a *network*-stalled variant, where a local spill genuinely helps rather than
  competing for the device that is already stalled.

---

## Repository map

```
bin/          generator · recorder · sigctl · sigval · uiserver      (the five processes)
src/signal/   the deterministic signal. Pure, no I/O — shared by generator and validator
src/format/   crc32c · wire · block-header · file-header · trailer   (the third-party contract)
src/ring/     bounded byte ring (recorder) and block ring (generator)
src/acquire/  absolute-deadline scheduler · recorder ingest state machine · bounded drop ledger
src/store/    writer (transpose, one-write-in-flight) · reader (O(1) seek) · recover (truncation)
src/viz/      min/max envelope decimation. Pure.
ui/           React 19 + TypeScript + Tailwind 4; committed bundle in ui/dist
test/         25 tests — signal determinism, scheduler algebra, transport invariants, recorder ingest
bench/        corrupt.mjs (validator proven failing) · stalled-consumer.mjs (R11) · write-stall.mjs (slow disk)
scripts/      demo.sh — starts all three processes, then verifies on clean shutdown
tools/        independent_reader.py — the format spec, proven
docs/         FORMAT.md — complete standalone specification
PLAN.md       full architecture and rationale, including every rejected alternative
MEASUREMENT-PLAN.md   measurement methodology, fault matrix, anti-patterns
```

## Stated assumptions

The brief invites either clarification or a documented assumption. These were resolved by assumption:

1. **"Samples" in the required validator output means values, not frames.** The brief's own arithmetic
   (460,800,000 in one hour at 32 × 4,000) counts values, so all CLI output reports values while the
   format addresses frames internally. Drop ledgers print both indices to remove any ambiguity.
2. **A nominal run is expected to drop nothing**, and the loss policy applies only under defined
   overload — sustained write throughput below 0.5 MB/s for longer than the ring's 131-second
   absorption window.
3. **Channel labels are metadata only.** The optional 10–20 electrode names in the viewer are for
   recognisability; the data is synthetic and is not claimed to be real EEG.
4. **The quality indicators are synthetic**, labelled as such in the UI itself, and measure no
   electrode impedance.
