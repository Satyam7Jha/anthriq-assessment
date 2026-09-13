/** Wire types shared with bin/uiserver.js. */

export interface Marker {
  kind: 'GAP' | 'RESYNC';
  onsetSeconds: number;
  durationSeconds: number;
  startFrameIndex: number;
  frameCount: number;
  label: string;
}

export interface Meta {
  file: string;
  fileSizeBytes: number;
  channelCount: number;
  sampleRateHz: number;
  dtype: string;
  layout: string;
  totalFrames: number;
  totalValues: number;
  durationSeconds: number;
  finalised: boolean;
  hadDrops: boolean;
  signalId: string;
  ringSeconds: number;
  markers: Marker[];
  droppedValues: number;
}

export interface ChannelQuality {
  rms: number;
  peakToPeak: number;
  flat: boolean;
  railed: boolean;
}

export interface RecorderHealth {
  valuesReceived: number;
  bytesWritten: number;
  ringFillPct: number;
  ringPeakPct: number;
  ringHeadroomSeconds: number;
  ringLevel: 'NORMAL' | 'ELEVATED' | 'HIGH';
  writeLatencyMaxMs: number;
  droppedFrames: number;
  droppedRanges: number;
  crcFailures: number;
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
  rateMultiplier: number;
  mode: 'live' | 'review';
  position: number;
  seekCost?: SeekCost;
}

/** The JSON half of a binary frame from GET /api/frame. */
export interface FrameInfo {
  from: number;
  to: number;
  frames: number;
  columns: number;
  channels: number[];
  quality: Record<string, ChannelQuality>;
  sampleRateHz: number;
  totalFrames: number;
  finalised: boolean;
  bytesRead: number;
  predictedBytes: number;
  allChannelBytes: number;
  transport: TransportState;
  recorder: RecorderHealth | null;
}

/** The pixel half: channels.length x columns x [min, max], NaN where there is no data. */
export interface Envelopes {
  channels: number[];
  columns: number;
  data: Float32Array;
}

export interface Validation {
  exitCode: number;
  report: {
    result: string;
    expectedValues: number;
    recordedValues: number;
    missing: number;
    duplicated: number;
    incorrect: number;
    ledgerAgreesWithDerivedGaps: boolean | null;
    elapsedSeconds: number;
  } | null;
  stderr: string;
}
