// The server contract (src/server/). Kept in one place so a server change shows up as a type error.

export interface Marker {
  onsetSeconds: number;
  durationSeconds: number;
  cause: string;
}

/** What this server allows, so the interface can say so before it happens. 0 means no limit. */
export interface Limits {
  maxRecordingSeconds: number;
  csvMaxSeconds: number;
}

/** GET /api/meta before anything has been recorded. */
export interface EmptyMeta {
  empty: true;
  channelCount: number;
  sampleRateHz: number;
  limits: Limits;
}

/** GET /api/meta for an open or finished recording. */
export interface Meta {
  empty?: false;
  file: string;
  fileSizeBytes: number;
  channelCount: number;
  sampleRateHz: number;
  dtype: string;
  totalFrames: number;
  totalValues: number;
  /** One past the last frame index: the end of the timeline, gaps included. */
  endFrame: number;
  durationSeconds: number;
  finalised: boolean;
  signalId: string;
  droppedValues: number;
  markers: Marker[];
  limits: Limits;
}

export interface RecorderHealth {
  ringFillPct: number;
  writeLatencyMaxMs: number;
  droppedFrames: number;
  rssBytes: number;
}

export interface SeekCost {
  microseconds: number;
  bytesRead: number;
  method: string;
  probes: number;
}

export interface TransportState {
  state: 'PLAYING' | 'PAUSED';
  mode: 'live' | 'review';
  rateMultiplier: number;
  position: number;
  seekCost?: SeekCost;
}

export type TransportCommand =
  | { op: 'play' }
  | { op: 'pause' }
  | { op: 'rate'; multiplier: number }
  | { op: 'seek'; frame: number }
  | { op: 'mode'; mode: 'live' | 'review' };

/** The JSON half of a binary frame from GET /api/frame. */
export interface FrameInfo {
  from: number;
  frames: number;
  columns: number;
  channels: number[];
  sampleRateHz: number;
  totalFrames: number;
  endFrame: number;
  finalised: boolean;
  bytesRead: number;
  predictedBytes: number;
  allChannelBytes: number;
  transport: TransportState;
  recorder: RecorderHealth | null;
}

/** The pixel half: channels x columns x [min, max]; NaN where there is no data. */
export interface Envelopes {
  channels: number[];
  columns: number;
  data: Float32Array;
}

/** Where a discrepancy was first found. Channels are 0-based here, as in the file. */
export interface Discrepancy {
  valueIndex?: number;
  frameIndex?: number;
  timeSeconds?: number;
  channel?: number;
  valueCount?: number;
  blockIndex?: number;
  byteOffset?: number;
  expected?: number;
  actual?: number;
  cause?: string;
}

/** `sigval --json`, as the validator process prints it (src/verify/validate.ts). */
export interface ValidationReport {
  result: 'PASS' | 'PASS (TRUNCATED)' | 'FAIL';
  exitCode: number;
  expectedValues: number;
  recordedValues: number;
  missing: number;
  duplicated: number;
  incorrect: number;
  corrupt: number;
  finalised: boolean;
  recovered: boolean;
  truncated: boolean;
  blockCount: number;
  firstDiscrepancy: Record<'missing' | 'duplicated' | 'incorrect' | 'corrupt', Discrepancy | null>;
  declaredDroppedValues: number | null;
  ledgerAgreesWithDerivedGaps: boolean | null;
  crcChecked: boolean;
  elapsedSeconds: number;
  throughputValuesPerSecond: number;
  peakRssBytes: number;
}

export interface Validation {
  exitCode: number | null;
  report: ValidationReport | null;
  stderr: string;
}

export interface Session {
  state: 'idle' | 'recording' | 'stopping' | 'verifying' | 'done';
  file: string | null;
  validation: Validation | null;
  error: string | null;
}
