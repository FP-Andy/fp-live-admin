'use client';

import { useEffect, useRef } from 'react';
import Hls from 'hls.js';

type Props = {
  src: string;
  paused?: boolean;
};

export default function HlsPlayer({ src, paused = false }: Props) {
  const ref = useRef<HTMLVideoElement>(null);

  const getSeekRange = (video: HTMLVideoElement): { start: number; end: number } | null => {
    if (video.seekable && video.seekable.length > 0) {
      return {
        start: video.seekable.start(0),
        end: video.seekable.end(video.seekable.length - 1),
      };
    }
    // Some live browsers report seekable late; use buffered as a fallback window.
    if (video.buffered && video.buffered.length > 0) {
      return {
        start: video.buffered.start(0),
        end: video.buffered.end(video.buffered.length - 1),
      };
    }
    return null;
  };

  const seekBy = (seconds: number) => {
    const video = ref.current;
    if (!video) return;
    const range = getSeekRange(video);
    if (!range) return;

    const { start, end } = range;
    // For live streams, calculate rewind/forward relative to live edge for stable behavior.
    const next = Math.min(end, Math.max(start, end + seconds));
    video.currentTime = next;
  };

  useEffect(() => {
    const video = ref.current;
    if (!video || !src) return;

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      return;
    }

    if (Hls.isSupported()) {
      const hls = new Hls({
        liveSyncDurationCount: 6,
        maxBufferLength: 60,
        liveBackBufferLength: 360,
        lowLatencyMode: false,
      });
      hls.loadSource(src);
      hls.attachMedia(video);
      return () => hls.destroy();
    }
  }, [src]);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;

    if (paused) {
      video.pause();
      return;
    }

    const playPromise = video.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(() => undefined);
    }
  }, [paused, src]);

  return (
    <div className="grid" style={{ gap: 8 }}>
      <video ref={ref} controls autoPlay muted playsInline style={{ width: '100%', borderRadius: 8, background: '#000' }} />
      <div className="row" style={{ gap: 8 }}>
        <button onClick={() => seekBy(-5)}>-5s</button>
        <button onClick={() => seekBy(-10)}>-10s</button>
        <button onClick={() => seekBy(-30)}>-30s</button>
        <button onClick={() => seekBy(5)}>+5s</button>
      </div>
    </div>
  );
}
