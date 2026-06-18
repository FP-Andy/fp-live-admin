'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// 캡처 사진(또는 분석용 영상에서 가져온 프레임) 위에 고정된 "선수 박스"를 띄우고,
// 사진을 드래그/확대해서 분석할 선수를 박스 안에 맞춘 뒤 그 영역만 잘라 PNG Blob으로 저장한다.

const CONT_W = 360;
const CONT_H = 360;
const BOX_W = 96;
const BOX_H = 168;
const BOX_LEFT = (CONT_W - BOX_W) / 2;
const BOX_TOP = (CONT_H - BOX_H) / 2;
const CENTER_X = CONT_W / 2;
const CENTER_Y = CONT_H / 2;

type Transform = { base: number; zoom: number; tx: number; ty: number };

const fmtTime = (s: number) => {
  if (!Number.isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

export default function ReferenceCropper({
  onSaved,
  videoFile,
}: {
  onSaved: (blob: Blob | null) => void;
  videoFile?: File | null;
}) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [savedUrl, setSavedUrl] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [curTime, setCurTime] = useState(0);
  const imgElRef = useRef<HTMLImageElement | null>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [tf, setTf] = useState<Transform>({ base: 1, zoom: 1, tx: 0, ty: 0 });
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  useEffect(() => {
    return () => {
      if (imgUrl) URL.revokeObjectURL(imgUrl);
      if (savedUrl) URL.revokeObjectURL(savedUrl);
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [imgUrl, savedUrl, videoUrl]);

  // 캡처된/선택된 이미지를 크롭 단계로 올린다. 박스를 덮도록 cover 기준으로 초기 배치.
  const loadImageForCrop = useCallback((url: string) => {
    const im = new Image();
    im.onload = () => {
      imgElRef.current = im;
      const base = Math.max(CONT_W / im.naturalWidth, CONT_H / im.naturalHeight);
      const dispW = im.naturalWidth * base;
      const dispH = im.naturalHeight * base;
      setTf({ base, zoom: 1, tx: (CONT_W - dispW) / 2, ty: (CONT_H - dispH) / 2 });
      setImgUrl(url);
    };
    im.src = url;
  }, []);

  const pickFile = (f: File | null) => {
    if (!f) return;
    if (imgUrl) URL.revokeObjectURL(imgUrl);
    if (savedUrl) URL.revokeObjectURL(savedUrl);
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(null);
    setSavedUrl(null);
    onSaved(null);
    loadImageForCrop(URL.createObjectURL(f));
  };

  // 분석용으로 선택한 영상 파일을 탐색 단계로 띄운다.
  const openVideo = () => {
    if (!videoFile) return;
    if (imgUrl) URL.revokeObjectURL(imgUrl);
    if (savedUrl) URL.revokeObjectURL(savedUrl);
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setImgUrl(null);
    imgElRef.current = null;
    setSavedUrl(null);
    onSaved(null);
    setDuration(0);
    setCurTime(0);
    setVideoUrl(URL.createObjectURL(videoFile));
  };

  const seekTo = (t: number) => {
    setCurTime(t);
    if (videoElRef.current) videoElRef.current.currentTime = t;
  };

  // 영상의 현재 프레임을 캡처해 크롭 단계로 넘긴다.
  const captureFrame = () => {
    const v = videoElRef.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) return;
      if (imgUrl) URL.revokeObjectURL(imgUrl);
      // videoUrl은 "다른 장면 선택"을 위해 그대로 둔다.
      loadImageForCrop(URL.createObjectURL(blob));
    }, 'image/png');
  };

  const k = tf.base * tf.zoom;

  const setZoom = (nextZoom: number) => {
    setTf((prev) => {
      const k0 = prev.base * prev.zoom;
      const k1 = prev.base * nextZoom;
      // 박스 중앙 아래 있는 원본 지점을 고정한 채 확대/축소한다.
      const srcX = (CENTER_X - prev.tx) / k0;
      const srcY = (CENTER_Y - prev.ty) / k0;
      return { ...prev, zoom: nextZoom, tx: CENTER_X - srcX * k1, ty: CENTER_Y - srcY * k1 };
    });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!imgElRef.current) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, tx: tf.tx, ty: tf.ty };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setTf((prev) => ({ ...prev, tx: d.tx + (e.clientX - d.x), ty: d.ty + (e.clientY - d.y) }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
  };

  const saveCrop = useCallback(() => {
    const im = imgElRef.current;
    if (!im) return;
    // 박스 영역(컨테이너 좌표)을 원본 픽셀로 환산한다.
    let sx = (BOX_LEFT - tf.tx) / k;
    let sy = (BOX_TOP - tf.ty) / k;
    let sw = BOX_W / k;
    let sh = BOX_H / k;
    // 원본 경계로 클램프한다.
    sx = Math.max(0, Math.min(sx, im.naturalWidth));
    sy = Math.max(0, Math.min(sy, im.naturalHeight));
    sw = Math.max(1, Math.min(sw, im.naturalWidth - sx));
    sh = Math.max(1, Math.min(sh, im.naturalHeight - sy));

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(sw);
    canvas.height = Math.round(sh);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(im, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) return;
      if (savedUrl) URL.revokeObjectURL(savedUrl);
      setSavedUrl(URL.createObjectURL(blob));
      onSaved(blob);
    }, 'image/png');
  }, [k, tf.tx, tf.ty, savedUrl, onSaved]);

  const clearImage = () => {
    if (imgUrl) URL.revokeObjectURL(imgUrl);
    if (savedUrl) URL.revokeObjectURL(savedUrl);
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setImgUrl(null);
    setSavedUrl(null);
    setVideoUrl(null);
    imgElRef.current = null;
    onSaved(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  // "다른 장면 선택": 크롭을 버리고 영상 탐색으로 돌아간다.
  const backToVideo = () => {
    if (imgUrl) URL.revokeObjectURL(imgUrl);
    if (savedUrl) URL.revokeObjectURL(savedUrl);
    setImgUrl(null);
    setSavedUrl(null);
    imgElRef.current = null;
    onSaved(null);
  };

  const mode: 'empty' | 'video' | 'crop' = imgUrl ? 'crop' : videoUrl ? 'video' : 'empty';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => pickFile(e.target.files?.[0] || null)}
      />
      <div
        onClick={mode === 'empty' ? () => fileRef.current?.click() : undefined}
        style={{
          position: 'relative',
          width: CONT_W,
          height: CONT_H,
          maxWidth: '100%',
          borderRadius: 8,
          overflow: 'hidden',
          background: '#000',
          border: '1px solid var(--border-ghost)',
          touchAction: 'none',
          cursor: mode === 'crop' ? 'grab' : mode === 'empty' ? 'pointer' : 'default',
          userSelect: 'none',
        }}
        onPointerDown={mode === 'crop' ? onPointerDown : undefined}
        onPointerMove={mode === 'crop' ? onPointerMove : undefined}
        onPointerUp={mode === 'crop' ? onPointerUp : undefined}
        onPointerCancel={mode === 'crop' ? onPointerUp : undefined}
      >
        {mode === 'crop' && imgUrl ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imgUrl}
              alt="capture"
              draggable={false}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                transformOrigin: 'top left',
                transform: `translate(${tf.tx}px, ${tf.ty}px) scale(${k})`,
                width: imgElRef.current?.naturalWidth ?? 'auto',
                height: imgElRef.current?.naturalHeight ?? 'auto',
                pointerEvents: 'none',
              }}
            />
            {/* 가운데 박스: 바깥쪽을 어둡게 마스킹하고 박스 안만 보이게 한다. */}
            <div
              style={{
                position: 'absolute',
                left: BOX_LEFT,
                top: BOX_TOP,
                width: BOX_W,
                height: BOX_H,
                border: '2px solid var(--accent, #3b82f6)',
                borderRadius: 4,
                boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
                pointerEvents: 'none',
              }}
            />
          </>
        ) : mode === 'video' && videoUrl ? (
          /* eslint-disable-next-line jsx-a11y/media-has-caption */
          <video
            ref={videoElRef}
            src={videoUrl}
            playsInline
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }}
          />
        ) : (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              color: 'var(--muted, #999)',
              fontSize: 13,
            }}
          >
            <span style={{ fontSize: 28, lineHeight: 1 }}>＋</span>
            <span>클릭해서 캡처 사진을 업로드하세요</span>
          </div>
        )}
      </div>

      {mode === 'empty' && videoFile ? (
        <button
          type="button"
          onClick={openVideo}
          style={{
            padding: '8px 14px',
            borderRadius: 8,
            border: '1px solid var(--accent, #3b82f6)',
            background: 'transparent',
            color: 'var(--accent, #3b82f6)',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          🎬 영상에서 가져오기
        </button>
      ) : null}

      {mode === 'video' ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: CONT_W, maxWidth: '100%' }}>
            <span style={{ fontSize: 12, color: 'var(--muted, #999)', minWidth: 34 }}>{fmtTime(curTime)}</span>
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.05}
              value={curTime}
              onChange={(e) => seekTo(Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <span style={{ fontSize: 12, color: 'var(--muted, #999)', minWidth: 34, textAlign: 'right' }}>{fmtTime(duration)}</span>
          </div>

          <p style={{ fontSize: 12, color: 'var(--muted, #999)', margin: 0 }}>
            슬라이더로 분석할 선수가 잘 보이는 장면을 찾은 뒤 캡처하세요.
          </p>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={captureFrame}
              style={{
                padding: '8px 14px',
                borderRadius: 8,
                border: 'none',
                background: 'var(--accent, #3b82f6)',
                color: '#fff',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              이 장면 캡처
            </button>
            <button
              type="button"
              onClick={clearImage}
              style={{
                padding: '8px 14px',
                borderRadius: 8,
                border: '1px solid var(--border-ghost)',
                background: 'transparent',
                color: 'var(--muted, #999)',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              취소
            </button>
          </div>
        </>
      ) : null}

      {mode === 'crop' ? (
      <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: CONT_W, maxWidth: '100%' }}>
        <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>축소</span>
        <input
          type="range"
          min={1}
          max={5}
          step={0.05}
          value={tf.zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          style={{ flex: 1 }}
        />
        <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>확대</span>
      </div>

      <p style={{ fontSize: 12, color: 'var(--muted, #999)', margin: 0 }}>
        사진을 드래그하고 슬라이더로 확대해 분석할 선수를 파란 박스 안에 맞춘 뒤 저장하세요.
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          type="button"
          onClick={saveCrop}
          style={{
            padding: '8px 14px',
            borderRadius: 8,
            border: 'none',
            background: 'var(--accent, #3b82f6)',
            color: '#fff',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          이 위치로 저장
        </button>
        {videoUrl ? (
          <button
            type="button"
            onClick={backToVideo}
            style={{
              padding: '8px 14px',
              borderRadius: 8,
              border: '1px solid var(--border-ghost)',
              background: 'transparent',
              color: 'var(--muted, #999)',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            다른 장면 선택
          </button>
        ) : null}
        <button
          type="button"
          onClick={clearImage}
          style={{
            padding: '8px 14px',
            borderRadius: 8,
            border: '1px solid var(--border-ghost)',
            background: 'transparent',
            color: 'var(--muted, #999)',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          사진 변경
        </button>
        {savedUrl ? (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={savedUrl}
              alt="saved"
              style={{ height: 56, borderRadius: 4, border: '1px solid var(--border-ghost)' }}
            />
            <span style={{ fontSize: 12, color: '#22c55e', fontWeight: 600 }}>저장됨 ✓</span>
          </span>
        ) : null}
      </div>
      </>
      ) : null}
    </div>
  );
}
