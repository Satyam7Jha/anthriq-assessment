/** Wire types shared with bin/uiserver.js. Kept in one file so a server change that breaks the
 *  contract shows up as a type error rather than as an empty canvas. */

export interface Marker {
  kind: 'GAP' | 'RESYNC' | 'OVERFLOW' | 'USER';
  onsetSeconds: number;
  durationSeconds: number;
  startFrameIndex: number;
  frameCount: number;
  label: string;
}

export interface Meta {
  file: string;
  path: string;
  fileSizeBytes: number;
  channelCount: number;
  sampleRateHz: number;
  framesPerBlock: number;
  blockStrideBytes: number;
  dtype: string;
  bytesPerValue: number;
  layout: string;
  totalFrames: number;
  totalValues: number;
  durationSeconds: number;
  finalised: boolean;
  recovered: boolean;
  hadDrops: boolean;
  signalId: string;
  ditherDisabled: boolean;
  startTimestampUnixNanos: string;
  recordingId: string;
  producer: string;
  ringBytes: number;
  ringSeconds: number;
  markers: Marker[];
  droppedFrames: number;
  droppedValues: number;
}

export interface ChannelQuality {
  rms: number;
  peakToPeak: number;
  flat: boolean;
  railed: boolean;
  columns: number;
  samplesPerColumn: number;
}

export interface RecorderHealth {
  elapsedSeconds: number;
  framesReceived: number;
  valuesReceived: number;
  blocksWritten: number;
  bytesWritten: number;
  ringFillPct: number;
  ringPeakPct: number;
  ringHeadroomSeconds: number;
  ringLevel: 'NORMAL' | 'ELEVATED' | 'HIGH';
  queuedBlocks: number;
  writeLatencyMaxMs: number;
  fsyncCount: number;
  fsyncMaxMs: number;
  gaps: number;
  gapFrames: number;
  duplicateFrames: number;
  crcFailures: number;
  corruptBytes: number;
  droppedFrames: number;
  droppedRanges: number;
  rssBytes: number;
}

export interface TransportState {
  state: 'PLAYING' | 'PAUSED';
  cursorFrame: number;
  rateMultiplier: number;
  mode: 'live' | 'review';
  position: number;
  seekCost?: {
    microseconds: number;
    bytesRead: number;
    readCalls: number;
    method: string;
    probes: number;
  };
}

/** One decimated window. `channels` maps channel index -> base64 of a Float32Array laid out as
 *  [min0, max0, min1, max1, …] — the min/max envelope, one pair per pixel column. */
export interface WindowPayload {
  from: number;
  to: number;
  frames: number;
  columns: number;
  channels: Record<string, string>;
  quality: Record<string, ChannelQuality>;
  sampleRateHz: number;
  totalFrames: number;
  finalised: boolean;
  bytesRead: number;
  allChannelBytes: number;
  predictedBytes: number;
  transport: TransportState;
  recorder?: RecorderHealth | null;
  serverTime?: number;
}

export type Envelopes = Map<number, Float32Array>;
