'use client';

import { useEffect, useRef } from 'react';
import Hls from 'hls.js';

type Props = {
  src: string;
  paused?: boolean;
};

export default function HlsPlayer({ src, paused = false }: Props) {
  const ref = useRef<HTMLVideoElement>(null);

  const seekBy = (seconds: number) => {
    const video = ref.current;
    if (!video) return;
    const base = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const next = Math.max(0, base + seconds);
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
        <button onClick={() => seekBy(5)}>+5s</button>
      </div>
    </div>
  );
}
