'use client';

import { useEffect, useMemo, useState } from 'react';
import { API_BASE, apiJson } from '../../../../lib/api';

const TEMPLATES_PER_PAGE = 5;

type FcmTemplate = {
  id: string;
  name: string;
  match_regex: string;
  image_url: string;
  priority: number;
  active: boolean;
  created_at: string;
  updated_at: string;
};

function formatDateTime(value: string) {
  return new Date(value).toLocaleString('ko-KR', {
    hour12: false,
    timeZone: 'Asia/Seoul',
  });
}

export default function FcmTemplatesPage() {
  const [templates, setTemplates] = useState<FcmTemplate[]>([]);
  const [name, setName] = useState('');
  const [matchRegex, setMatchRegex] = useState('');
  const [priority, setPriority] = useState(100);
  const [active, setActive] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [testTeamName, setTestTeamName] = useState('');
  const [templatePage, setTemplatePage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const previewUrl = useMemo(() => {
    if (!file) return '';
    return URL.createObjectURL(file);
  }, [file]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const load = async () => {
    try {
      setLoading(true);
      const data = await apiJson<FcmTemplate[]>('/fcm/templates');
      setTemplates(Array.isArray(data) ? data : []);
      setError('');
    } catch (loadError) {
      setTemplates([]);
      setError(loadError instanceof Error ? loadError.message : '템플릿 목록을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const matchedTemplate = useMemo(() => {
    const target = testTeamName.trim();
    if (!target) return null;
    return templates.find((template) => {
      if (!template.active) return false;
      try {
        return new RegExp(template.match_regex, 'i').test(target);
      } catch {
        return false;
      }
    }) || null;
  }, [templates, testTeamName]);

  const totalTemplatePages = Math.max(1, Math.ceil(templates.length / TEMPLATES_PER_PAGE));
  const pagedTemplates = useMemo(() => {
    const start = (templatePage - 1) * TEMPLATES_PER_PAGE;
    return templates.slice(start, start + TEMPLATES_PER_PAGE);
  }, [templatePage, templates]);

  useEffect(() => {
    if (templatePage > totalTemplatePages) {
      setTemplatePage(totalTemplatePages);
    }
  }, [templatePage, totalTemplatePages]);

  const saveTemplate = async () => {
    if (!file) {
      setError('템플릿 이미지를 선택하세요.');
      return;
    }
    if (!name.trim() || !matchRegex.trim()) {
      setError('템플릿 이름과 Regex를 입력하세요.');
      return;
    }

    setSaving(true);
    setError('');
    setMessage('');

    const form = new FormData();
    form.append('name', name.trim());
    form.append('match_regex', matchRegex.trim());
    form.append('priority', String(priority));
    form.append('active', String(active));
    form.append('file', file);

    try {
      const response = await fetch(`${API_BASE}/fcm/templates`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      if (!response.ok) {
        throw new Error((await response.text()) || '템플릿 저장에 실패했습니다.');
      }
      setName('');
      setMatchRegex('');
      setPriority(100);
      setActive(true);
      setFile(null);
      setMessage('템플릿이 등록되었습니다.');
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '템플릿 저장에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page-stack">
      <section className="card card-hero page-hero">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">FinePlay Card Marker</div>
            <h2 style={{ margin: '6px 0 0' }}>Templates</h2>
          </div>
          <span className="status-pill tech">FCM</span>
        </div>
      </section>

      <section className="fcm-template-grid">
        <div className="card card-panel fcm-template-form">
          <div className="section-heading">
            <div>
              <div className="sidebar-eyebrow">Register</div>
              <h3 style={{ margin: '6px 0 0' }}>템플릿 등록</h3>
            </div>
          </div>

          <label className="field-stack">
            <span className="field-label">템플릿 이름</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="예: 당진 기본 카드" />
          </label>

          <label className="field-stack">
            <span className="field-label">호출 Regex</span>
            <input value={matchRegex} onChange={(event) => setMatchRegex(event.target.value)} placeholder="예: 당진|당진시민" />
          </label>

          <div className="fcm-template-form-row">
            <label className="field-stack">
              <span className="field-label">우선순위</span>
              <input
                min={1}
                step={1}
                type="number"
                value={priority}
                onChange={(event) => setPriority(Math.max(1, Number(event.target.value) || 1))}
              />
            </label>
            <label className="field-stack">
              <span className="field-label">사용 여부</span>
              <select value={active ? 'true' : 'false'} onChange={(event) => setActive(event.target.value === 'true')}>
                <option value="true">Active</option>
                <option value="false">Inactive</option>
              </select>
            </label>
          </div>

          <label className="field-stack fvc-dropzone" htmlFor="fcm-template-image">
            <span>템플릿 이미지</span>
            <strong>{file ? file.name : 'PNG/JPG 선택'}</strong>
            <input
              accept="image/png,image/jpeg"
              id="fcm-template-image"
              type="file"
              onChange={(event) => setFile(event.target.files?.[0] || null)}
            />
          </label>

          {previewUrl ? (
            <div className="fcm-template-preview">
              <img alt="새 템플릿 미리보기" src={previewUrl} />
            </div>
          ) : null}

          {message ? <p className="field-help" style={{ color: 'var(--success)' }}>{message}</p> : null}
          {error ? <p className="field-help" style={{ color: '#ff9c8f' }}>{error}</p> : null}

          <button className="btn-primary" disabled={saving} onClick={saveTemplate} type="button">
            {saving ? '저장 중' : '템플릿 등록'}
          </button>
        </div>

        <div className="page-stack">
          <section className="card card-panel">
            <div className="section-heading">
              <div>
                <div className="sidebar-eyebrow">Rule Test</div>
                <h3 style={{ margin: '6px 0 0' }}>호출 규칙 미리보기</h3>
              </div>
            </div>
            <label className="field-stack">
              <span className="field-label">팀명 테스트</span>
              <input value={testTeamName} onChange={(event) => setTestTeamName(event.target.value)} placeholder="예: 당진시민축구단" />
            </label>
            <div className="field-help" style={{ marginTop: 14 }}>
              {testTeamName.trim()
                ? matchedTemplate
                  ? `${matchedTemplate.name} / ${matchedTemplate.match_regex}`
                  : '등록된 Regex 템플릿과 매칭되지 않습니다. 카드 생성 시 기존 파일명 fallback을 시도합니다.'
                : '팀명을 입력하면 우선순위 기준으로 호출될 템플릿을 확인할 수 있습니다.'}
            </div>
            {matchedTemplate ? (
              <div className="fcm-template-match-preview">
                <img alt={`${matchedTemplate.name} preview`} src={`${API_BASE}/fcm/templates/${matchedTemplate.id}/image`} />
              </div>
            ) : null}
          </section>

          <section className="card card-panel">
            <div className="section-heading">
              <div>
                <div className="sidebar-eyebrow">Templates</div>
                <h3 style={{ margin: '6px 0 0' }}>등록된 템플릿</h3>
              </div>
              <span className="status-pill">{templates.length}</span>
            </div>

            {loading ? <p className="field-help">템플릿 목록을 불러오는 중입니다.</p> : null}
            {!loading && templates.length === 0 ? <p className="field-help">등록된 Regex 템플릿이 없습니다.</p> : null}

            <div className="fcm-template-list">
              {pagedTemplates.map((template) => (
                <article className="fcm-template-card" key={template.id}>
                  <img alt={`${template.name} preview`} src={`${API_BASE}/fcm/templates/${template.id}/image`} />
                  <div className="grid" style={{ gap: 8 }}>
                    <div className="section-heading">
                      <strong>{template.name}</strong>
                      <span className={`status-pill ${template.active ? 'running' : 'stopped'}`}>
                        {template.active ? 'ACTIVE' : 'INACTIVE'}
                      </span>
                    </div>
                    <code>{template.match_regex}</code>
                    <div className="muted">
                      priority {template.priority} / updated {formatDateTime(template.updated_at)}
                    </div>
                  </div>
                </article>
              ))}
            </div>
            {templates.length > TEMPLATES_PER_PAGE ? (
              <div className="pagination-bar">
                <span className="muted">
                  Page {templatePage} / {totalTemplatePages}
                </span>
                <div className="pagination-pages">
                  {Array.from({ length: totalTemplatePages }, (_, index) => index + 1).map((page) => (
                    <button
                      className={page === templatePage ? 'btn-primary' : 'btn-ghost'}
                      key={page}
                      onClick={() => setTemplatePage(page)}
                      type="button"
                    >
                      {page}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </section>
        </div>
      </section>
    </div>
  );
}
