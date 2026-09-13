# sigacq — continuous multi-channel biosignal acquisition, recording, retrieval and playback

A 32-channel, 4,000 Hz acquisition pipeline in Node.js and React: a deterministic signal generated in
one process, streamed to a separate recorder process over a Unix domain socket, persisted to a
self-describing binary format with zero sample loss and flat memory, and retrievable, replayable and
verifiable afterwards. Plus a biosignal review viewer that renders it without ever being able to
touch the acquisition path.

**Live demo:** https://sigacq.onrender.com — press Record, then Stop; the recording is validated
automatically. It runs on Render's free tier, so the first request after a quiet spell can take about
a minute, and a shared fraction of a CPU is not the machine the figures below were measured on.

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
| One-hour run, 460,800,000 samples | **0 missing, 0 duplicated, 0 incorrect** — validator `PASS`, exit 0 |
| Sample loss over a 4.5-minute run **with the viewer attached throughout** | **0** — validator `PASS`, exit 0 |
| Generator pacing deviation over one hour | **2 frames in 14,400,000 = 0.14 ppm** |
| Tick lag over one hour | **p50 ≤ 16 µs, p99 ≤ 64 µs**; 252 late ticks in 720,000, none needing a resync |
| Recorder memory over one hour | **69–133 MiB, no upward trend** — first 10 min average 109 MiB, last 10 min 99 MiB |
| Ring-buffer peak utilisation over one hour | **0.76 %** of a 131-second absorption window |
| Generator pacing while the recorder is **SIGSTOPped for 10 s** | **unchanged** — deviation stays within one tick, 0 resyncs |
| Validator throughput / memory | **80 M values/s** on the 1.72 GiB one-hour file (5.8 s), **84.9 MiB peak**; flat from a 4 MiB file to that one |
| Channel-subset read, 2 of 32 | **15.97× fewer bytes**, measured == closed-form prediction exactly |
| Seek cost | **1 pread, 64 bytes, ~11 µs**, O(1) |
| Independent Python reader written from the spec alone | **identical values to 9 decimals**, 272/272 blocks verified |
| Slow disk, 1.5 s per write into a 1 MiB ring | loss reported as **751,360 missing, 0 incorrect**, ledger agrees, file finalised |

---

## Quick start

### From the browser

```bash
npm install && npm run ui:build && npm start
```

Open **http://localhost:8787** and press **Record**. The server starts the recorder and the generator
as two separate processes, exactly as the commands below would. Press **Stop** and the recording is
finalised and verified automatically; the result appears under **Verify**. Recordings go to
`./recordings/`.

Starting and stopping from the page does not weaken the process boundary: the viewer only launches
the two processes and sends them signals. It never joins their socket and never writes the file.

`npm install` and `npm run ui:build` are only needed for the viewer. Acquisition, storage, retrieval
and verification run on a bare checkout with no install step.

### Or run the processes yourself

```bash
# 1. Recorder first — it owns the socket and the file.
node bin/recorder.ts --out /tmp/run.sigb --stats-interval 5
```

```bash
# 2. Generator, in a second terminal: a separate process.
node bin/generator.ts --duration 60
```

```bash
# 3. Ctrl-C the recorder to finalise, then verify. Exit status is the machine-checkable result.
node bin/sigval.ts /tmp/run.sigb; echo "exit=$?"
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
node bin/sigctl.ts info /tmp/run.sigb
node bin/sigctl.ts read /tmp/run.sigb --from 10s --to 12s --channels 3,17
node bin/sigctl.ts play /tmp/run.sigb --speed 2 --out none      # keys: space · ← → · + − · q
npm install && npm run ui:build && node bin/uiserver.ts --follow /tmp/run.sigb   # then open :8787
```

### Deploying the viewer

The repository includes a `Dockerfile` and a `render.yaml`. The image needs no install or build step:
the backend has no runtime dependencies and the front-end bundle is committed.

```bash
docker build -t sigacq . && docker run -p 8787:8787 -e PORT=8787 sigacq
```

On Render, create a Blueprint from the repository; it reads `render.yaml`. The server honours `PORT`.
Because a public page lets anyone press Record, the image caps browser-started recordings at five
minutes and keeps the newest five (`SIGACQ_MAX_RECORDING_SECONDS`, `SIGACQ_KEEP_RECORDINGS`; unset
locally, so nothing is capped on your own machine). Shared hosting gives the processes a fraction of a
CPU, so a hosted instance demonstrates the system; the figures in this README are from the machine
named at the top.

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

- **A ↔ B is a socket** because the assessment requires two processes, and because it is
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

`node bench/stalled-consumer.ts --stall 10` runs the pair to steady state, **SIGSTOPs the recorder
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
exhausted.

The last check is the one worth dwelling on. The recorder logs the ranges it knows it lost. The
validator, separately, derives gaps **from block headers alone**, with no access to that ledger. They
agree exactly — 365,440 values, same two ranges, same positions. Two independent derivations of the
same fact.

---

## The deterministic signal

The validator recomputes the expected signal and compares **bit patterns**. That only works if the
signal is bit-reproducible, which rules out the obvious choice of waveform:

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
`bytesPerValue` are independent fields, so a 3-byte type is expressible, and `layoutCode` is
a field rather than an assumption.

### Alternatives considered

Each established format fails at least one property this brief requires:

| Failure mode | Formats |
|---|---|
| Header/footer finalised **at close** ⇒ an interrupted file is not self-describing | EDF, EDF+, BDF, GDF, Parquet, HDF5, NPY |
| **Lossy integer quantisation** ⇒ exact validation impossible | EDF, EDF+, BDF |
| **Mandatory interleaving** ⇒ 32× read amplification for one channel | WAV, RF64/BW64 |
| Size, parse cost, or float round-tripping | CSV, JSONL, OpenBCI text |
| Native dependency | HDF5, SQLite, liblsl |
| Not specifiable in four pages | MNE/FIF |

The standards are not the problem: **the clinical formats are
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
node bin/sigval.ts FILE.sigb            # 0 PASS · 1 FAIL · 2 PASS(TRUNCATED) · 3 UNREADABLE
```

Single streaming pass, **O(1) memory**: one reused block buffer, one 64-byte header buffer, a 4-byte
scratch, and a dozen counters. Neither the recording nor the expected signal is ever materialised —
the expected signal is recomputed one value at a time from the closed-form function. Measured at
**~90 M values/s with 86.7 MiB peak RSS**, flat across a 124× range of file sizes; a one-hour recording
validates in about five seconds.

`Missing` is derived from **sequence gaps**, not from `Expected − Recorded`, because those two can
legitimately disagree (duplicates inflate `Recorded`) and reporting both makes the discrepancy itself
a signal.

A **fourth class, `Corrupt`**, is reported beyond what the brief asks for, and only when non-zero so
the nominal output still matches the required format byte-for-byte. Without it a bit-rotted block
would be reported as 128,000 "incorrect values" — technically true and diagnostically useless.

### The validator is demonstrated failing

An always-PASS validator is indistinguishable from `exit 0`. `bench/corrupt.ts` damages a good
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
node bin/sigctl.ts info  FILE.sigb                                   # metadata
node bin/sigctl.ts read  FILE.sigb --from 10s --to 12s --channels 3,17 --out csv
node bin/sigctl.ts read  FILE.sigb --from "#400000" --to "1:30" --channels 0-7
node bin/sigctl.ts seek  FILE.sigb --at 0s,2.5s,600s                 # measured seek cost
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

### Real-time playback

```bash
node bin/sigctl.ts play FILE.sigb --speed 1 --channels 0-7 --out raw | your-consumer
(sleep 2; echo pause; sleep 1; echo resume; echo "seek 30s"; echo "speed 4") | node bin/sigctl.ts play FILE.sigb --out none
```

`sigctl play` re-emits a recording as interleaved float32 frames on stdout, **paced by the same
absolute-deadline scheduler as the generator**, at any multiple of the native rate from 0.05× to 16×.
On a terminal it takes keys (space, ← →, + −, q); otherwise one command per line on stdin, so a
session can be scripted. Human-readable output goes to stderr, keeping the stream clean.

- **Pause, resume, seek and a speed change** each close the current pacing segment and open a new one
  at the exact frame reached. Position is never lost, and paused time is not owed — the one deliberate
  difference from acquisition, where it is.
- **Seek** is the reader's O(1) block lookup: one 64-byte header read.
- **Accuracy is reported** when playback ends, against a stated bound. A segment emits the tick due at
  its own start, so it may lead by one tick; the report checks the deviation is within one tick per
  segment, and gives the tick-lag distribution.
- **A slow consumer never slows pacing.** When stdout is backed up past 4 MiB, frames are dropped and
  counted with the position of the first; frames lost at acquisition are emitted as `NaN` and counted.
- **Memory** is one tick of output plus one block-sized run buffer per selected channel.

```
  stopped        end of range, at 5.000 s (frame 20,000)
  channels       32 of 32
  played         20,000 frames in 5.529 s of playing time, 4 segment(s)
  expected       19,985 frames  (playing time × 4,000 Hz × speed)
  deviation      15 frames  (750.6 ppm)   bound: one tick per segment = 90 frames  WITHIN
  tick lag       p99 ≤ 128 µs (worst segment), max 760 µs, 0 late tick(s)
  lost           0 frames missing in the recording · 0 dropped for a slow consumer
```

The viewer has the same controls (0.25×–8×), but its cursor is simpler by design: it only needs the
right position twenty times a second, so it is computed from the monotonic clock as
`anchorFrame + elapsed × rate × multiplier` rather than emitted as a sample-accurate stream.

---

## The front end

React 19 + TypeScript + Tailwind 4, built with esbuild into a committed static bundle.

The brief files the visualizer under "optional" and says visual polish is not assessed. It is built as
a first-class deliverable anyway, for an architectural reason rather than a cosmetic one: **the
properties this system is graded on — pacing accuracy, bounded buffering, positioned loss, O(1) seek,
channel-subset economy — are all invisible in a terminal.** The front end makes them visible.

Two consequences for what got built.

**It is a recognisable instrument, not a generic chart.** The canonical view for multi-channel ExG is
a stacked column of per-channel traces sharing one time axis, with per-channel gain, a time base in
seconds-per-screen, and a montage selector.

**The interface is quiet, and ordered for a reviewer.** One trace view, one transport
bar, one inspector that answers questions in the order they get asked: *is the recording correct?*
(Verify, at the top), *what is it?* (Recording), *is acquisition healthy?* (Health), *how much am I
looking at?* (Channels shown: All · 16 · 8 · 4). Technical detail sits behind one disclosure. Rows
auto-fit their own range, so there is no scale control and a trace can never spill into its neighbour.
Three keys: Space plays or pauses, ← / → skip ten seconds. It is light-themed whatever the system
setting, since dark traces on a light ground read best, and the only saturated colours are the
accent, green and red — so lost samples or a failed verification are the one thing on screen that
draws the eye.

**The hard parts are kept hard, just out of sight:**

- **Zero React re-renders per frame.** Sample data lives in a ref outside the render cycle; one
  `requestAnimationFrame` loop hands frames to uCharts, one line series per channel, and redraws only
  when the view has moved by a column or new data has arrived: **0.98 ms** per redraw for 16 channels
  at 1440×900. The hover readout and lost-sample bands are drawn on a transparent canvas above the
  chart, so hovering never forces a chart redraw. Only low-frequency numbers go through state, at most
  four times a second.
- **Motion at the display's frame rate, not the network's.** Frames arrive about twenty times a
  second; each carries where the window is and how fast it is moving (1× while a recording grows, the
  playback speed in review, 0 when paused), and the view keeps moving between them, easing out any
  correction. uCharts places points on a category axis, so the view advances a pixel column at a time. The server sends two seconds more than the visible window, so the glide never runs past
  the data. A live recording is committed in one-second blocks, so the live view trails the newest data
  by about a block and scrolls continuously instead of in steps.
- **Traces that slide instead of shimmering.** Each pixel column is the min/max of a fixed number of
  samples on an absolute grid, so as the window moves a column keeps exactly the same samples and the
  trace translates, instead of every column re-binning slightly on every frame. Each channel zig-zags
  through its column maxima and minima, so a single-sample spike still reaches its full height, and a
  row rescales only when its signal leaves the lane or shrinks to under half of it.
- **Min/max envelope decimation, server-side.** At 4 kHz on a 1,000 px trace each pixel column covers
  40 samples. Subsampling shows a transient only if it lands on a sample point and averaging erases it;
  a min/max envelope means **a single-sample spike still extends its column and can never be hidden**.
- **Binary frames, pulled.** The browser asks for the next frame only after drawing the last one, and
  receives `[u32 length][JSON][float32 envelopes]`, read through a zero-copy `Float32Array` view — no
  base64, no per-byte decode, so nothing that needs a Worker. A slow tab simply asks less often; no
  backlog builds anywhere.
- **Channel selection changes what leaves the disk**, not what the browser draws: the reader issues
  `pread`s only for the selected channels, and the inspector footnote reports the saving and whether
  the measured byte count matches the closed-form prediction.
- **Lost samples are drawn, not just counted** — a soft red band across every row at the exact time.
- **Verification runs as a separate process**, and its report is shown as the five checks it makes —
  sample values, sequence, checksums, drop log, clean close — with the first position of any failure
  and the exit code as returned.
- **What is on screen can be taken away**: the `.sigb` file as recorded, its `.json` metadata, or the
  visible window and channels as CSV (capped at 60 s and streamed, so a large request cannot exhaust
  the server).

### It cannot affect acquisition, structurally

The UI server never connects to the acquisition socket and never talks to the recorder. It opens the
`.sigb` `O_RDONLY` and uses positional reads; it tails the recorder's stats NDJSON the same read-only
way. There is **no channel through which it could exert backpressure**. If the viewer is slow,
crashes, or is never started, the recording is bit-identical.

The price, stated plainly: **~1.1 s of display latency**, because the view follows committed file
blocks rather than the live socket. A lower-latency variant would need a second consumer on the
generator's write path, which is precisely the coupling the brief forbids.

The 4.5-minute run in the headline table had the viewer attached and rendering for its entire
duration, and still validated `PASS` with zero loss; the one-hour run had it following the file for
its last minutes, with the same result.

---

## Measured performance

**Method.** Every figure below comes from a run on the target machine, on AC power, via the committed
scripts named. Timing uses `process.hrtime.bigint()` (a monotonic clock, `CLOCK_UPTIME_RAW` on
Darwin); memory uses `process.memoryUsage.rss()` sampled by the recorder itself.

### One-hour acceptance run — 3,600 s, 32 ch × 4,000 Hz

Recorder and generator started from the command line as in [Quick start](#quick-start), on AC power
with idle sleep held off by `caffeinate`; recorder RSS sampled externally with `ps` every 10 s
(359 samples); validator timed with `/usr/bin/time -l`.

```
Expected: 460,800,000 samples
Recorded: 460,800,000 samples
Missing:   0
Duplicated: 0
Incorrect:  0
Result: PASS
exit=0
validated 460,800,000 values in 5.76 s (80,008,071 values/s), CRC on    maximum resident set size 84.9 MiB
```

```
generator — final pacing report            recorder — final report
  elapsed          3600.000 s                size          1,843,434,520 B (1.7168 GiB)
  emitted          14,400,000 frames         frames        14,400,000 = 460,800,000 values
  expected (clock) 14,399,998 frames         blocks        3,600
  deviation        2 frames (0.139 ppm)      ring peak     0.76% of 64 MiB (131.1 s)
  tick lag         p50 ≤16 µs, p99 ≤64 µs    write latency max 8.88 ms
                   max 54,412 µs             fsyncs        359 (max 24.72 ms)
  late ticks       252 of 720,000            gaps/dups     0 / 0 frames
  pacing resyncs   0                         crc failures  0
  ring peak        11/1024 blocks (1.07%)    dropped       0 frames in 0 ranges
  drain stalls     0, peak socket queue 23 KB finalised    yes
  dropped          0 frames
```

Recorder RSS moved between 69 and 133 MiB in a garbage-collection sawtooth with no upward trend: the
first ten minutes averaged 109 MiB and the last ten 99 MiB. The worst single tick was 54 ms late and
cost nothing — the deadline schedule absorbed it, which is why the deviation stayed at two frames.
For the last few minutes the viewer was also following the file as it was written.

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
construction; **jitter** is the real measured quantity. A ppm figure without the tick-lag
histogram would hide the part that varies. The one 8.9 ms outlier is a single
scheduling excursion absorbed entirely by the deadline scheme — it cost zero frames, which is the
point.

### Memory

| Process | Measured | Grows with run duration? |
|---|---:|---|
| Recorder | **69–133 MiB over one hour**, GC sawtooth, no trend | **No** — 64 MiB ring + 2 × 512 KB block buffers + parser carry, all preallocated before the first byte is accepted |
| Validator | **86.7 MiB** | **No** — 86.8 / 86.6 / 86.6 MiB validating 4 MiB, 147 MiB and 497 MiB files |
| Reader (32 ch) | 512 KB working set | **No** — scales with the window and subset, not the recording |

**Where that memory goes.** Most of it is the runtime, not the workload. Node running a TypeScript
file directly sits at **66 MiB before doing anything** (44 MiB for plain JavaScript — the difference is
the built-in type-stripping loader). The validator's own working set is therefore about 20 MiB: one
reused 512 KB block buffer plus V8 heap. What matters for the brief is the slope, and it is zero —
peak RSS was identical to within 0.2 MiB validating files 124× apart in size. The recorder shows the same picture: over a 60-second TypeScript run its RSS moved in a V8 garbage-
collection sawtooth between 103 and 122 MiB and returned to 105 MiB, with no upward trend — every
buffer it uses is allocated before the first byte arrives.

The drop ledger is bounded at 65,536 entries with adjacent-entry coalescing, because **an unbounded
ledger is itself memory proportional to elapsed time** — exactly what the brief rules out. If the cap
were ever reached, counts stay exact, only the enumeration of positions is capped, and the file says
so via a header flag.

### Component costs

| Operation | Measured |
|---|---|
| Signal generation | 1.04 ms per 128,000 values (0.10 % of one core) |
| CRC-32C | 0.99 ms per 518,400 B = **526 MB/s**; check value `0xE3069283` verified |
| Validation | ~90 M values/s |
| Seek | ~11 µs, 1 pread, 64 B |
| Trace redraw, 16 channels at 1440×900, 1× playback (uCharts) | 0.98 ms |

### Reproducing the evidence

```bash
npm test                                          # 30 tests: signal, scheduler, formats, transport, ingest, playback
node bench/write-stall.ts                         # slow disk: loss reported as MISSING, 0 incorrect
node bench/corrupt.ts /tmp/run.sigb               # validator demonstrated FAILING, 4 classes
node bench/stalled-consumer.ts --stall 10         # R11: SIGSTOP the recorder, 7 assertions
python3 tools/independent_reader.py FILE.sigb --check --channels 3,17 --from 100 --to 102 --dump 3
```

---

## Independent reader

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
4. **Built-in defaults** — `src/config/defaults.ts`

Every resolved value carries its **source**, and both processes print it at startup, so "where did
this 4000 come from" never requires reading the code:

```
  channelCount           32                       [default]
  sampleRateHz           1000                     [env:SIGACQ_RATE]
  ringBytes              67108864                 [cli]
  derived                32,000 values/s, 128,000 B/s, block stride 128,064 B
```

Full option tables: `node bin/<tool>.ts --help`.

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
| **uCharts** for the trace view | A charting library in the front-end bundle only; acquisition stays dependency-free. Measured against a hand-written Canvas renderer on the same recording at 1× playback: 0.98 ms against 0.51 ms per redraw, and whole-column steps instead of sub-pixel motion, in exchange for a maintained chart component. Both are far inside a 16 ms frame. Highcharts, tried first, took 12.7 ms per update. |

### Bugs found during development

Four data-integrity bugs were found during development. The fault-injection tests caught three. The
fourth, and most serious, slipped through because no test yet stalled the disk itself; a code review
that wrote that test found it.

1. **A recorder-side drop silently mislabelled every later frame index** (found in code review).
   When the recorder's own ring overflowed, the dropped block had already advanced the wire parser,
   so the next block reported "no gap" and was appended to the open run. Every block after it carried
   a frame index short by the number of frames dropped — CRC-clean, self-consistent, and wrong. On a
   slow disk the validator reported *0 missing, 1,021,440 incorrect*. For an instrument that is worse
   than losing data: a gap is visible, a time shift is not. My stall test had only ever frozen the
   recorder process, so every drop happened upstream in the generator and took the path that worked.
   **Fix:** the ingest state machine now lives in `src/acquire/ingest.ts`, measures every gap against
   the last frame it actually *accepted*, and is unit-tested with frames that carry their own index as
   their value. `bench/write-stall.ts` reproduces that case and now reports
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
  a spectrogram. All are useful and out of scope; the right place for them is a
  transform stage in the reader, not the browser.
- **No reverse playback.** The brief asks for slower and faster, not backwards; the reader's block
  lookup would support it, but `sigctl play` only runs forward.
- **Measured on macOS only.** CI runs the tests and a 20-second end-to-end record-validate-play on
  Linux and macOS, but every figure in this README comes from the machine named at the top.
- **The viewer re-decimates its whole window on every frame** rather than caching envelopes per
  committed block. Buffers are reused, so this costs reads, not garbage — but a per-block cache is the
  right next step for many simultaneous viewers.
- **No physical units.** The header has no `vref`, per-channel gain or unit field, so values are
  dimensionless. The 3,572 reserved header bytes are where they belong.
- **Nothing longer than one hour has been measured.** The one-hour run shows no memory growth and
  every buffer is allocated before ingest, but there is no multi-hour RSS regression with a confidence
  interval on its slope.
- **`--test-concurrency=1` is pinned** in `npm test`: the transport test holds a socket with megabytes
  queued, and running it concurrently with the timing tests made both flaky.

## Future work

- 4-hour and 24-hour runs, reporting the RSS slope with a confidence interval.
- `sigctl export --format edf` — export a completed recording to EDF+ with explicit, documented
  per-channel `float32 → int16` scaling. Export at rest is the right place for a lossy interchange
  step; the acquisition path is the wrong place.
- An `int24` dtype (`dtypeCode 5`) with `vref`, per-channel `gain` and a `physicalUnit` header field,
  for a real ADS1299 front end — 25 % smaller files, and structural rather than value-based
  validation.
- Multi-device acquisition, where LSL's clock-offset model becomes the right prior art.
- Disk-full spill for a *network*-stalled variant, where a local spill helps rather than
  competing for the device that is already stalled.

---

## Repository map

Everything is TypeScript. Node runs the backend `.ts` files directly (native type stripping), so
acquisition, storage and verification still have **no build step and no runtime dependencies**;
`npm run typecheck` checks the whole project. No file is large: entry points in `bin/` are thin, and
each concern lives in its own module.

```
bin/                 thin entry points: generator · recorder · sigval · sigctl · uiserver
src/
  signal/            the deterministic signal — pure, shared by generator and validator
  format/            crc32c · wire · wire-parser · block-header · file-header · trailer
  ring/              bounded byte ring (recorder) · block ring (generator)
  acquire/           absolute-deadline scheduler · lag histogram · recorder ingest · drop ledger
  generator/         the generator process: hot path · non-blocking sender · report
  recorder/          the recorder process: wiring · telemetry · metadata-first shutdown
  store/             writer (one write in flight) · reader (O(1) seek) · recover (truncation)
  verify/            streaming validator · output formatting
  playback/          paced sample-stream player: pause · resume · seek · speed
  inspect/           sigctl subcommands: info · read · seek/hexdump · play
  server/            viewer server: recording view · frames · transport · session · routes
  viz/               min/max envelope decimation
  config/ util/      layered configuration · argv parsing · formatting · logging
ui/src/
  components/ui/     the shared component library: Button · IconButton · SegmentedControl · Select · ListGroup · StatusIcon
  features/          trace · transport · inspector · recording (toolbar, record button, empty state)
  hooks/             useRecording · useSession · useFrameStream · usePlayback · useKeyboard
  api/ lib/ app/     server client · formatting · composition root
test/                30 tests — signal, scheduler, formats, transport invariants, recorder ingest, playback
bench/               corrupt (validator shown failing) · stalled-consumer (frozen recorder) · write-stall (slow disk)
tools/               independent_reader.py — written from docs/FORMAT.md alone, in Python so it shares no code
docs/FORMAT.md       complete standalone specification
scripts/demo.sh      builds the viewer if needed and opens it, ready to record
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
