'use client';

import { useEffect, useRef, type ReactNode } from 'react';

// 되돌릴 수 없는 작업(경기 삭제, 기록 전체 삭제) 앞에 한 번 묻는 창.
// 브라우저 기본 확인 창은 버튼 이름을 바꿀 수 없어 "확인"만 보고 눌러 버리기 쉬웠다 —
// 무엇이 지워지는지 적고, 누를 버튼 이름 자체를 "삭제"로 둔다.
export default function ConfirmDialog({
  title,
  message,
  confirmLabel = '삭제',
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // 기본 초점은 "취소" — Enter 를 습관처럼 눌러도 지워지지 않게 한다.
    cancelRef.current?.focus();
    // 매치 컨트롤은 Q·W·E·A·S·D·Enter 를 창(window) 단축키로 받는다. 창이 떠 있는 동안
    // 그 키가 경기 입력으로 새지 않게 캡처 단계에서 막는다(버튼의 Enter 동작은 그대로다).
    const onKey = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, onCancel]);

  return (
    <div className="fcm-modal-backdrop" role="presentation" onClick={() => { if (!busy) onCancel(); }}>
      <div
        className="card card-panel fcm-modal confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <h3>{title}</h3>
        <div className="confirm-dialog-message">{message}</div>
        <div className="confirm-dialog-actions">
          <button ref={cancelRef} className="btn-secondary" disabled={busy} onClick={onCancel} type="button">취소</button>
          <button className="btn-danger" disabled={busy} onClick={onConfirm} type="button">{busy ? `${confirmLabel} 중…` : confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
