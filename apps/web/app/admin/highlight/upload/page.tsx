'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { API_BASE } from '../../../../lib/api';
import ReferenceCropper from './ReferenceCropper';
import ColorPicker from './ColorPicker';

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
  const [jerseyNumber, setJerseyNumber] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [uniformColor, setUniformColor] = useState('');
  const [refBlob, setRefBlob] = useState<Blob | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setJerseyNumber('');
    setPlayerName('');
    setUniformColor('');
    setRefBlob(null);
    setSourceUrl('');
    setFile(null);
    setProgress(0);
    if (fileRef.current) fileRef.current.value = '';
  };

  const videoProvided = tab === 'file' ? file !== null : sourceUrl.trim() !== '';
  const fieldsFilled =
    jerseyNumber.trim() !== '' &&
    playerName.trim() !== '' &&
    uniformColor !== '' &&
    refBlob !== null &&
    videoProvided;

  const submit = () => {
    if (uploading) return;
    if (!jerseyNumber.trim()) { setStatus('선수 등번호를 입력하세요.'); return; }
    if (!playerName.trim()) { setStatus('선수 이름을 입력하세요.'); return; }
    if (!uniformColor) { setStatus('유니폼 색을 선택하세요.'); return; }
    if (!refBlob) { setStatus('분석할 선수 이미지를 박스에 맞춰 저장하세요.'); return; }

    const form = new FormData();
    form.append('jersey_number', jerseyNumber.trim());
    form.append('player_name', playerName.trim());
    form.append('uniform_color', uniformColor);
    form.append('reference_image', refBlob, 'reference.png');

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
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ ...card, width: '100%' }}>
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

        {/* 등번호 · 선수 이름: 한 줄 배치 */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ width: 120 }}>
            <label style={label}>등번호 *</label>
            <input
              style={input}
              type="number"
              inputMode="numeric"
              value={jerseyNumber}
              onChange={(e) => setJerseyNumber(e.target.value)}
              placeholder="10"
            />
          </div>
          <div style={{ width: 240 }}>
            <label style={label}>선수 이름 *</label>
            <input
              style={input}
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              placeholder="홍길동"
            />
          </div>
        </div>

        {/* 분석 대상 이미지(좌) + 영상 업로드(우): 빈 공간 최소화 */}
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 16, alignItems: 'flex-start' }}>
          <div>
            <label style={label}>분석할 선수 이미지 *</label>
            <ReferenceCropper onSaved={setRefBlob} videoFile={tab === 'file' ? file : null} />
            <div style={{ display: 'flex', gap: 8, margin: '10px 0 0', maxWidth: 360, lineHeight: 1.55 }}>
              <span style={{ fontSize: 18, lineHeight: '1.4', flexShrink: 0 }}>💡</span>
              <p style={{ fontSize: 13.5, color: 'var(--accent, #3b82f6)', margin: 0 }}>
                박스 안에 <strong>등번호가 선명하게 보일수록</strong> 분석 품질이 높아집니다. 가능하면 등번호가 잘 보이는 장면을 골라 맞춰주세요.
              </p>
            </div>
          </div>

          <div style={{ flex: 1, minWidth: 240, maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ maxWidth: 260 }}>
              <label style={label}>유니폼 색 *</label>
              <ColorPicker value={uniformColor} onChange={setUniformColor} />
            </div>

            {tab === 'file' ? (
              <div>
                <label style={label}>영상 파일 *</label>
                <input
                  ref={fileRef}
                  type="file"
                  accept="video/*"
                  style={input}
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
                {file ? (
                  <p style={{ fontSize: 12, color: '#22c55e', margin: '6px 0 0' }}>선택됨: {file.name}</p>
                ) : null}
              </div>
            ) : (
              <div>
                <label style={label}>영상 링크 *</label>
                <input
                  style={input}
                  value={sourceUrl}
                  onChange={(e) => setSourceUrl(e.target.value)}
                  placeholder="https://..."
                />
              </div>
            )}

            {uploading && tab === 'file' ? (
              <div>
                <div style={{ height: 6, borderRadius: 3, background: 'var(--border-ghost)', overflow: 'hidden' }}>
                  <div style={{ width: `${progress}%`, height: '100%', background: 'var(--accent, #3b82f6)' }} />
                </div>
                <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>{progress}%</span>
              </div>
            ) : null}
          </div>
        </div>

        <button
          onClick={submit}
          disabled={uploading || !fieldsFilled}
          style={{
            padding: '10px 16px',
            borderRadius: 8,
            border: 'none',
            background: uploading || !fieldsFilled ? 'var(--border-ghost)' : 'var(--accent, #3b82f6)',
            color: '#fff',
            fontWeight: 600,
            cursor: uploading || !fieldsFilled ? 'default' : 'pointer',
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
