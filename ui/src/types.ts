// The server contract (src/server/). Kept in one place so a server change shows up as a type error.

export interface Marker {
  onsetSeconds: number;
  durationSeconds: number;
  cause: string;
}

/** GET /api/meta before anything has been recorded. */
export interface EmptyMeta {
  empty: true;
  channelCount: number;
  sampleRateHz: number;
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

export interface Validation {
  exitCode: number | null;
  report: {
    result: string;
    expectedValues: number;
    recordedValues: number;
    missing: number;
    duplicated: number;
    incorrect: number;
    elapsedSeconds: number;
  } | null;
  stderr: string;
}

export interface Session {
  state: 'idle' | 'recording' | 'stopping' | 'verifying' | 'done';
  file: string | null;
  validation: Validation | null;
  error: string | null;
}
