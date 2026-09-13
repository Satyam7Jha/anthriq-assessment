import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { FrameInfo, Meta, SeekCost, TransportCommand, TransportState } from '../types';

/**
 * Media-player semantics over the server's transport, so there are no modes to learn:
 *   - an open recording is a live stream: pause freezes the view, seeking leaves live, goLive returns;
 *   - a finished recording is a video: play starts from the beginning.
 */
export function usePlayback({ recording, info, recordingOpen, windowSeconds }: { recording: Meta | null; info: FrameInfo | null; recordingOpen: boolean; windowSeconds: number }) {
  const [transport, setTransport] = useState<TransportState | null>(null);
  const [seekCost, setSeekCost] = useState<SeekCost | null>(null);

  // The frame stream carries the server's transport state; adopt it as it arrives.
  useEffect(() => {
    if (info) setTransport(info.transport);
  }, [info]);

  const send = useCallback(async (cmd: TransportCommand) => {
    const next = await api.transport(cmd);
    setTransport(next);
    if (next.seekCost) setSeekCost(next.seekCost);
  }, []);

  const rate = recording?.sampleRateHz ?? 1;
  const isLive = (transport?.mode ?? 'live') === 'live';
  const liveEdge = info?.endFrame ?? recording?.endFrame ?? 0;

  /** Leave the live edge at `frame`, paused. */
  const leaveLive = useCallback(async (frame: number) => {
    await send({ op: 'mode', mode: 'review' });
    await send({ op: 'pause' });
    await send({ op: 'seek', frame });
  }, [send]);

  const playPause = useCallback(() => {
    const half = Math.floor((windowSeconds * rate) / 2);
    if (!isLive) return void send({ op: transport?.state === 'PLAYING' ? 'pause' : 'play' });
    if (recordingOpen) return void leaveLive(Math.max(0, liveEdge - half));
    void leaveLive(half).then(() => send({ op: 'play' }));
  }, [windowSeconds, rate, isLive, recordingOpen, liveEdge, transport, send, leaveLive]);

  const seek = useCallback((frame: number) => void (isLive ? leaveLive(frame) : send({ op: 'seek', frame })), [isLive, leaveLive, send]);

  const skip = useCallback((seconds: number) => seek(Math.max(0, (isLive ? liveEdge : (transport?.position ?? 0)) + seconds * rate)), [seek, isLive, liveEdge, transport, rate]);

  return {
    isLive,
    recordingOpen,
    playing: isLive ? recordingOpen : transport?.state === 'PLAYING',
    positionSeconds: (transport?.position ?? 0) / rate,
    rate: transport?.rateMultiplier ?? 1,
    sampleRateHz: rate,
    seekCost,
    playPause,
    seek,
    skip,
    goLive: () => void send({ op: 'mode', mode: 'live' }),
    setRate: (multiplier: number) => void send({ op: 'rate', multiplier }),
  };
}

export type Playback = ReturnType<typeof usePlayback>;
