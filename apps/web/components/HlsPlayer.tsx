'use client';

import { useEffect, useRef } from 'react';
import Hls from 'hls.js';

type Props = {
  src: string;
  paused?: boolean;
};

export default function HlsPlayer({ src, paused = false }: Props) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video || !src) return;

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      return;
    }

    if (Hls.isSupported()) {
      const hls = new Hls({
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 4,
        maxBufferLength: 10,
        liveBackBufferLength: 30,
        lowLatencyMode: true,
        maxLiveSyncPlaybackRate: 1.2,
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
    <video ref={ref} controls autoPlay muted playsInline style={{ width: '100%', borderRadius: 8, background: '#000' }} />
  );
}
