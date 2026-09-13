// Single source of truth for every tunable constant.

export const DEFAULTS = {
  // Signal
  CHANNEL_COUNT: 32,
  SAMPLE_RATE_HZ: 4000,
  SIGNAL_ID: 'tri+saw+hash32/v1',
  DITHER: true,

  // Numeric representation
  DTYPE_CODE: 1, // float32LE
  BYTES_PER_VALUE: 4,

  // Generator pacing
  TICK_NANOS: 5_000_000n, // 5 ms
  MAX_CATCHUP_TICKS: 40, // <= 200 ms of catch-up before PACING_RESYNC

  // Transport
  SOCKET_HWM_BYTES: 1024 * 1024, // the drain loop never queues more than this
  GENERATOR_RING_BLOCKS: 1024, // ~5.12 s of absorption at defaults

  // Recorder
  RECORDER_RING_BYTES: 64 * 1024 * 1024, // ~131 s of absorption at defaults
  MIN_RING_BYTES: 1024 * 1024,
  FRAMES_PER_FILE_BLOCK: 4000, // one second at defaults
  FSYNC_INTERVAL_SECONDS: 10,
  MAX_LEDGER_ENTRIES: 65_536, // bounded: an uncapped ledger is time-proportional memory
  STATS_INTERVAL_SECONDS: 10,
  SHUTDOWN_WATCHDOG_MS: 1500, // floor for the drain budget, and the grace after it
  SHUTDOWN_DRAIN_MAX_MS: 15_000, // never wait longer than this for a stalled disk

  // File format
  FILE_MAGIC: 'SIGBLK01',
  FILE_HEADER_BYTES: 4096,
  BLOCK_HEADER_BYTES: 64,
  BLOCK_MAGIC: 0x424c4b42, // "BLKB"
  TRAILER_MAGIC: 'SIGTRLR1',
  FORMAT_VERSION: 1,
  LAYOUT_BLOCK_PLANAR: 1,
  ENDIAN_MARKER: 0x01020304,

  // Wire. Bytes 'S','G','B','1' read back as a little-endian u32.
  WIRE_MAGIC: 0x31424753,
  WIRE_HEADER_BYTES: 32,
  WIRE_VERSION: 1,

  // Viewer
  UI_PORT: 8787,
} as const;
