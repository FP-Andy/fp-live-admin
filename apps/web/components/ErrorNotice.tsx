'use client';

import { useState, type CSSProperties } from 'react';
import { formatErrorInfo, lookupErrorInfo, type ErrorInfo } from '../lib/error-messages';

/**
 * 오류 원문 접기 — "자세히"를 눌러야 상태 코드·서버 사유·요청 주소·원문이 보인다.
 * 숨긴 코드·원문은 자세히/툴팁으로 볼 수 있어야 한다(lib/error-messages.ts 머리말).
 * info 를 안 주면 message 로 최근 오류 원문을 찾아 쓴다(문자열 state 화면용).
 */
export function ErrorFold({ message, info, raw }: { message?: string | null; info?: ErrorInfo; raw?: string | null }) {
  const [copied, setCopied] = useState(false);
  const found = info || lookupErrorInfo(message) || (raw ? { message: message || '', raw } : undefined);
  const text = found ? formatErrorInfo(raw && found.raw !== raw ? { ...found, raw } : found) : '';
  if (!text) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // http 화면처럼 클립보드를 못 쓰면 선택 복사로 대신한다.
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); } catch { /* 직접 선택해 복사 */ }
      area.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <details className="fpc-error-fold">
      <summary>자세히</summary>
      <div className="fpc-error-fold-body">
        <pre>{text}</pre>
        <button type="button" className="fpc-error-copy" onClick={() => void copy()}>{copied ? '복사됨' : '복사'}</button>
      </div>
    </details>
  );
}

/** 한국어 사유 한 줄 + 자세히(원문). message 가 비면 아무것도 그리지 않는다. */
export default function ErrorNotice({
  message, info, raw, className = '', style, role = 'alert',
}: {
  message?: string | null;
  info?: ErrorInfo;
  raw?: string | null;
  className?: string;
  style?: CSSProperties;
  role?: 'alert' | 'status';
}) {
  if (!message) return null;
  return (
    <div className={`fpc-error-notice ${className}`.trim()} role={role} style={style}>
      <span className="fpc-error-text">{message}</span>
      <ErrorFold message={message} info={info} raw={raw} />
    </div>
  );
}
