'use client';

import { useEffect, useRef } from 'react';
import Hls from 'hls.js';

type Props = {
  src: string;
};

export default function HlsPlayer({ src }: Props) {
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

  return <video ref={ref} controls autoPlay muted style={{ width: '100%', borderRadius: 8, background: '#000' }} />;
}
