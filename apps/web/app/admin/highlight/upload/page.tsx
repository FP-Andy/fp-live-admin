'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { API_BASE } from '../../../../lib/api';

const card: React.CSSProperties = {
  background: 'var(--surface-card)',
  borderRadius: 'var(--radius-card)',
  padding: 20,
  border: '1px solid var(--border-ghost)',
};

const label: React.CSSProperties = { fontSize: 13, fontWeight: 600, marginBottom: 6, display: 'block' };
const input: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid var(--border-ghost)',
  background: 'var(--surface-input, #1b1b1f)',
  color: 'var(--text, #eee)',
  fontSize: 14,
};

type Tab = 'file' | 'link';

export default function HighlightUploadPage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('file');
  const [displayName, setDisplayName] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setDisplayName('');
    setSourceUrl('');
    setFile(null);
    setProgress(0);
    if (fileRef.current) fileRef.current.value = '';
  };

  const submit = () => {
    if (uploading) return;
    const form = new FormData();
    if (displayName.trim()) form.append('display_name', displayName.trim());

    if (tab === 'file') {
      if (!file) { setStatus('영상 파일을 선택하세요.'); return; }
      form.append('video', file);
    } else {
      if (!sourceUrl.trim()) { setStatus('링크를 입력하세요.'); return; }
      form.append('source_url', sourceUrl.trim());
    }

    setUploading(true);
    setProgress(0);
    setStatus(tab === 'file' ? '업로드 중...' : '링크 등록 중...');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/highlight/operator-jobs`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) setProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      setUploading(false);
      if (xhr.status >= 200 && xhr.status < 300) {
        setStatus('완료되었습니다.');
        reset();
        router.push('/admin/highlight/my');
      } else {
        setStatus(xhr.responseText || `업로드 실패 (${xhr.status})`);
      }
    };
    xhr.onerror = () => { setUploading(false); setStatus('업로드 실패'); };
    xhr.send(form);
  };

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={card}>
        <h2 style={{ fontSize: 18, marginTop: 0, marginBottom: 4 }}>영상 업로드</h2>
        <p style={{ fontSize: 13, color: 'var(--muted, #999)', marginTop: 0 }}>
          영상 파일 또는 링크를 업로드하면 처리 대기열에 등록됩니다.
        </p>

        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {(['file', 'link'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: '6px 14px',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
                border: '1px solid var(--border-ghost)',
                background: tab === t ? 'var(--accent, #3b82f6)' : 'transparent',
                color: tab === t ? '#fff' : 'var(--muted, #999)',
              }}
            >
              {t === 'file' ? '파일 업로드' : '링크 업로드'}
            </button>
          ))}
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={label}>이름 (선택)</label>
          <input
            style={input}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="예: 6월 15일 경기"
          />
        </div>

        {tab === 'file' ? (
          <div style={{ marginBottom: 14 }}>
            <label style={label}>영상 파일</label>
            <input
              ref={fileRef}
              type="file"
              accept="video/*"
              style={input}
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
          </div>
        ) : (
          <div style={{ marginBottom: 14 }}>
            <label style={label}>영상 링크</label>
            <input
              style={input}
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="https://..."
            />
          </div>
        )}

        {uploading && tab === 'file' ? (
          <div style={{ marginBottom: 12 }}>
            <div style={{ height: 6, borderRadius: 3, background: 'var(--border-ghost)', overflow: 'hidden' }}>
              <div style={{ width: `${progress}%`, height: '100%', background: 'var(--accent, #3b82f6)' }} />
            </div>
            <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>{progress}%</span>
          </div>
        ) : null}

        <button
          onClick={submit}
          disabled={uploading}
          style={{
            padding: '10px 16px',
            borderRadius: 8,
            border: 'none',
            background: uploading ? 'var(--border-ghost)' : 'var(--accent, #3b82f6)',
            color: '#fff',
            fontWeight: 600,
            cursor: uploading ? 'default' : 'pointer',
            width: '100%',
          }}
        >
          {uploading ? '처리 중...' : '업로드'}
        </button>

        {status ? (
          <p style={{ fontSize: 13, color: 'var(--muted, #999)', marginBottom: 0 }}>{status}</p>
        ) : null}
      </div>
    </div>
  );
}
