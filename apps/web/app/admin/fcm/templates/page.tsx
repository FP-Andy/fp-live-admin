'use client';

import { useEffect, useMemo, useState } from 'react';
import { API_BASE, apiJson } from '../../../../lib/api';

const TEMPLATES_PER_PAGE = 5;
const DEFAULT_COMPETITION_CLASS = 'K3';

type CompetitionClass = {
  code: string;
  name: string;
  first_half_minutes: number;
  second_half_minutes: number;
  created_at: string;
};

type FcmTemplate = {
  id: string;
  name: string;
  competition_class?: string | null;
  match_regex: string;
  image_url: string;
  card_type: 'PLAYER' | 'GOALKEEPER';
  priority: number;
  active: boolean;
  created_at: string;
  updated_at: string;
};

type TemplateEditDraft = {
  name: string;
  competition_class: string;
  match_regex: string;
  card_type: 'PLAYER' | 'GOALKEEPER';
  priority: number;
  active: boolean;
};

function formatDateTime(value: string) {
  return new Date(value).toLocaleString('ko-KR', {
    hour12: false,
    timeZone: 'Asia/Seoul',
  });
}

function normalizeClass(value?: string | null) {
  return (value || '').trim().toUpperCase();
}

function templateImageUrl(template: FcmTemplate) {
  return `${API_BASE}/fcm/templates/${template.id}/image`;
}

function regexMatches(template: FcmTemplate, target: string) {
  try {
    return new RegExp(template.match_regex, 'i').test(target);
  } catch {
    return false;
  }
}

function templateClassLabel(template: FcmTemplate) {
  return template.competition_class ? normalizeClass(template.competition_class) : 'LEGACY';
}

export default function FcmTemplatesPage() {
  const [templates, setTemplates] = useState<FcmTemplate[]>([]);
  const [competitionClasses, setCompetitionClasses] = useState<CompetitionClass[]>([]);
  const [name, setName] = useState('');
  const [competitionClass, setCompetitionClass] = useState(DEFAULT_COMPETITION_CLASS);
  const [matchRegex, setMatchRegex] = useState('');
  const [cardType, setCardType] = useState<'PLAYER' | 'GOALKEEPER'>('PLAYER');
  const [priority, setPriority] = useState(100);
  const [active, setActive] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [testTeamName, setTestTeamName] = useState('');
  const [testCompetitionClass, setTestCompetitionClass] = useState(DEFAULT_COMPETITION_CLASS);
  const [testCardType, setTestCardType] = useState<'PLAYER' | 'GOALKEEPER'>('PLAYER');
  const [templatePage, setTemplatePage] = useState(1);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<TemplateEditDraft | null>(null);
  const [updatingTemplateId, setUpdatingTemplateId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const previewUrl = useMemo(() => {
    if (!file) return '';
    return URL.createObjectURL(file);
  }, [file]);

  const classOptions = useMemo(() => {
    const codes = competitionClasses.map((item) => normalizeClass(item.code)).filter(Boolean);
    return codes.length ? codes : [DEFAULT_COMPETITION_CLASS];
  }, [competitionClasses]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  useEffect(() => {
    if (!classOptions.includes(competitionClass)) {
      setCompetitionClass(classOptions[0]);
    }
    if (!classOptions.includes(testCompetitionClass)) {
      setTestCompetitionClass(classOptions[0]);
    }
  }, [classOptions, competitionClass, testCompetitionClass]);

  const load = async () => {
    try {
      setLoading(true);
      const [templateData, classData] = await Promise.all([
        apiJson<FcmTemplate[]>('/fcm/templates'),
        apiJson<CompetitionClass[]>('/competition-classes').catch(() => []),
      ]);
      setTemplates(Array.isArray(templateData) ? templateData : []);
      setCompetitionClasses(Array.isArray(classData) ? classData : []);
      setError('');
    } catch (loadError) {
      setTemplates([]);
      setCompetitionClasses([]);
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
    const selectedClass = normalizeClass(testCompetitionClass);
    if (!target || !selectedClass) return null;

    const classSpecific = templates.find((template) => {
      if (!template.active) return false;
      if (normalizeClass(template.competition_class) !== selectedClass) return false;
      if ((template.card_type || 'PLAYER') !== testCardType) return false;
      return regexMatches(template, target);
    });
    if (classSpecific) return classSpecific;

    return templates.find((template) => {
      if (!template.active || normalizeClass(template.competition_class)) return false;
      if ((template.card_type || 'PLAYER') !== testCardType) return false;
      return regexMatches(template, target);
    }) || null;
  }, [templates, testCardType, testCompetitionClass, testTeamName]);

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
    if (!name.trim() || !matchRegex.trim() || !competitionClass) {
      setError('템플릿 이름, 대회 클래스, Regex를 입력하세요.');
      return;
    }

    setSaving(true);
    setError('');
    setMessage('');

    const form = new FormData();
    form.append('name', name.trim());
    form.append('competition_class', competitionClass);
    form.append('match_regex', matchRegex.trim());
    form.append('card_type', cardType);
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
      setCardType('PLAYER');
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

  const startEdit = (template: FcmTemplate) => {
    setEditingTemplateId(template.id);
    setEditDraft({
      name: template.name,
      competition_class: normalizeClass(template.competition_class) || classOptions[0],
      match_regex: template.match_regex,
      card_type: template.card_type || 'PLAYER',
      priority: template.priority,
      active: template.active,
    });
    setMessage('');
    setError('');
  };

  const cancelEdit = () => {
    setEditingTemplateId(null);
    setEditDraft(null);
    setUpdatingTemplateId(null);
  };

  const saveTemplateEdit = async (templateId: string) => {
    if (!editDraft) return;
    if (!editDraft.name.trim() || !editDraft.match_regex.trim() || !editDraft.competition_class) {
      setError('템플릿 이름, 대회 클래스, Regex를 입력하세요.');
      return;
    }

    setUpdatingTemplateId(templateId);
    setError('');
    setMessage('');
    try {
      await apiJson<FcmTemplate>(`/fcm/templates/${templateId}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: editDraft.name.trim(),
          competition_class: editDraft.competition_class,
          match_regex: editDraft.match_regex.trim(),
          card_type: editDraft.card_type,
          priority: editDraft.priority,
          active: editDraft.active,
        }),
      });
      setMessage('템플릿이 수정되었습니다.');
      cancelEdit();
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '템플릿 수정에 실패했습니다.');
    } finally {
      setUpdatingTemplateId(null);
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
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="예: K3 경주한수원 기본 카드" />
          </label>

          <label className="field-stack">
            <span className="field-label">대회 클래스</span>
            <select value={competitionClass} onChange={(event) => setCompetitionClass(event.target.value)}>
              {classOptions.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>

          <label className="field-stack">
            <span className="field-label">호출 Regex</span>
            <input value={matchRegex} onChange={(event) => setMatchRegex(event.target.value)} placeholder="예: 경주한수원|한수원" />
          </label>

          <label className="field-stack">
            <span className="field-label">카드 유형</span>
            <select value={cardType} onChange={(event) => setCardType(event.target.value as 'PLAYER' | 'GOALKEEPER')}>
              <option value="PLAYER">주요선수 카드</option>
              <option value="GOALKEEPER">골키퍼 카드</option>
            </select>
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
            <div className="fcm-template-form-row">
              <label className="field-stack">
                <span className="field-label">대회 클래스</span>
                <select value={testCompetitionClass} onChange={(event) => setTestCompetitionClass(event.target.value)}>
                  {classOptions.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-stack">
                <span className="field-label">팀명 테스트</span>
                <input value={testTeamName} onChange={(event) => setTestTeamName(event.target.value)} placeholder="예: 경주한수원" />
              </label>
              <label className="field-stack">
                <span className="field-label">카드 유형</span>
                <select value={testCardType} onChange={(event) => setTestCardType(event.target.value as 'PLAYER' | 'GOALKEEPER')}>
                  <option value="PLAYER">주요선수</option>
                  <option value="GOALKEEPER">골키퍼</option>
                </select>
              </label>
            </div>
            <div className="field-help" style={{ marginTop: 14 }}>
              {testTeamName.trim()
                ? matchedTemplate
                  ? `${templateClassLabel(matchedTemplate)} / ${matchedTemplate.name} / ${matchedTemplate.match_regex}`
                  : '선택한 대회 클래스의 Regex 템플릿과 매칭되지 않습니다. 카드 생성 시 기존 파일명 fallback을 시도합니다.'
                : '대회 클래스와 팀명을 입력하면 카드 생성에서 호출될 템플릿을 확인할 수 있습니다.'}
            </div>
            {matchedTemplate ? (
              <div className="fcm-template-match-preview">
                <img alt={`${matchedTemplate.name} preview`} src={templateImageUrl(matchedTemplate)} />
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
              {pagedTemplates.map((template) => {
                const isEditing = editingTemplateId === template.id;
                return (
                  <article className="fcm-template-card" key={template.id}>
                    <img alt={`${template.name} preview`} src={templateImageUrl(template)} />
                    <div className="grid" style={{ gap: 8 }}>
                      {isEditing && editDraft ? (
                        <div className="fcm-template-edit">
                          <div className="fcm-template-edit-grid">
                            <label className="field-stack">
                              <span className="field-label">템플릿 이름</span>
                              <input
                                value={editDraft.name}
                                onChange={(event) => setEditDraft((prev) => prev ? { ...prev, name: event.target.value } : prev)}
                              />
                            </label>
                            <label className="field-stack">
                              <span className="field-label">대회 클래스</span>
                              <select
                                value={editDraft.competition_class}
                                onChange={(event) => setEditDraft((prev) => prev ? { ...prev, competition_class: event.target.value } : prev)}
                              >
                                {classOptions.map((item) => (
                                  <option key={item} value={item}>
                                    {item}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="field-stack fcm-template-edit-wide">
                              <span className="field-label">호출 Regex</span>
                              <input
                                value={editDraft.match_regex}
                                onChange={(event) => setEditDraft((prev) => prev ? { ...prev, match_regex: event.target.value } : prev)}
                              />
                            </label>
                            <label className="field-stack">
                              <span className="field-label">카드 유형</span>
                              <select
                                value={editDraft.card_type}
                                onChange={(event) => setEditDraft((prev) => prev ? { ...prev, card_type: event.target.value as 'PLAYER' | 'GOALKEEPER' } : prev)}
                              >
                                <option value="PLAYER">주요선수</option>
                                <option value="GOALKEEPER">골키퍼</option>
                              </select>
                            </label>
                            <label className="field-stack">
                              <span className="field-label">우선순위</span>
                              <input
                                min={1}
                                step={1}
                                type="number"
                                value={editDraft.priority}
                                onChange={(event) =>
                                  setEditDraft((prev) => prev ? { ...prev, priority: Math.max(1, Number(event.target.value) || 1) } : prev)
                                }
                              />
                            </label>
                            <label className="field-stack">
                              <span className="field-label">사용 여부</span>
                              <select
                                value={editDraft.active ? 'true' : 'false'}
                                onChange={(event) => setEditDraft((prev) => prev ? { ...prev, active: event.target.value === 'true' } : prev)}
                              >
                                <option value="true">Active</option>
                                <option value="false">Inactive</option>
                              </select>
                            </label>
                          </div>
                          <div className="fcm-template-actions">
                            <button
                              className="btn-primary button-compact"
                              disabled={updatingTemplateId === template.id}
                              onClick={() => saveTemplateEdit(template.id)}
                              type="button"
                            >
                              {updatingTemplateId === template.id ? '저장 중' : '수정 저장'}
                            </button>
                            <button className="btn-ghost button-compact" onClick={cancelEdit} type="button">
                              취소
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="section-heading">
                            <strong>{template.name}</strong>
                            <span className={`status-pill ${template.active ? 'running' : 'stopped'}`}>
                              {template.active ? 'ACTIVE' : 'INACTIVE'}
                            </span>
                          </div>
                          <div className="fcm-chip-list" style={{ margin: 0 }}>
                            <span className="fcm-chip">{templateClassLabel(template)}</span>
                            <span className="fcm-chip">{template.card_type === 'GOALKEEPER' ? '골키퍼' : '주요선수'}</span>
                            {!template.competition_class ? <span className="fcm-chip">fallback</span> : null}
                          </div>
                          <code>{template.match_regex}</code>
                          <div className="muted">
                            priority {template.priority} / updated {formatDateTime(template.updated_at)}
                          </div>
                          <div className="fcm-template-actions">
                            <button className="btn-secondary button-compact" onClick={() => startEdit(template)} type="button">
                              정규식 수정
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </article>
                );
              })}
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
