'use client';

import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import SceneMotionView, { sceneMotionDuration, type SceneData } from '../../../components/SceneMotionView';

declare global {
  interface Window {
    fpcSceneCapture?: {
      load: (data: SceneData, width: number) => number;
      seek: (seconds: number) => void;
    };
  }
}

/** No session or stored match data: the internal renderer supplies sceneData. */
export default function SceneMotionCapturePage() {
  const [scene, setScene] = useState<{ data: SceneData; width: number } | null>(null);
  const [time, setTime] = useState(0);
  useEffect(() => {
    window.fpcSceneCapture = {
      load(data, width) {
        flushSync(() => { setScene({ data, width }); setTime(0); });
        return sceneMotionDuration(data);
      },
      seek(seconds) { flushSync(() => setTime(seconds)); },
    };
    return () => { delete window.fpcSceneCapture; };
  }, []);
  return <main style={{ position: 'fixed', inset: 0, background: '#0a0e0c', margin: 0, padding: 0 }}>
    {scene ? <SceneMotionView data={scene.data} width={scene.width} frameTime={time} /> : null}
  </main>;
}
