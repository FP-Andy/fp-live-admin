'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { API_BASE, apiFetch, apiJson, type SessionUser } from '../../../lib/api';
import { useSportContext, type Sport } from '../../../components/SportContext';

type Match = {
  id: string;
  name: string;
  sport?: Sport;
  competition_class: string;
  round_number: number;
  first_half_minutes: number;
  second_half_minutes: number;
  archived: boolean;
  archived_at?: string | null;
  created_at: string;
  hls_url?: string;
  metadata?: {
    stream_mode?: 'STREAM' | 'MANUAL';
    ingest_protocol?: 'SRT' | 'RTMP';
    ingest_url?: string;
    rtmp?: {
      server_url?: string;
      stream_key?: string;
      push_url?: string;
      pull_url?: string;
    };
  } | null;
  operator_id?: string | null;
};

type StreamStatus = {
  running_match_ids?: string[];
};

type CompetitionClass = {
  code: string;
  name: string;
  first_half_minutes: number;
  second_half_minutes: number;
  extra_first_half_minutes?: number;
  extra_second_half_minutes?: number;
  team_options?: string[];
  created_at: string;
};

type ScheduleEntry = {
  id: string;
  league: string;
  round_label: string;
  match_date: string;
  kickoff_time: string;
  home_team: string;
  away_team: string;
  fla_staff: string;
  fpa_home_staff: string;
  fpa_away_staff: string;
  created_at: string;
  updated_at: string;
};

type ScheduleForm = Omit<ScheduleEntry, 'id' | 'created_at' | 'updated_at'>;

const TEAM_OPTIONS_BY_CLASS: Record<string, string[]> = {
  K3: [
    'FC강릉',
    'FC목포',
    '경주한수원FC',
    '당진시민축구단',
    '대전코레일FC',
    '부산교통공사축구단',
    '시흥시민축구단',
    '양평FC',
    '여주FC',
    '울산시민축구단',
    '전북현대모터스',
    '창원FC',
    '춘천시민축구단',
    '포천시민축구단',
  ],
  WK: [
    '강진SWANSWFC',
    '경주한수원WFC',
    '상무여자축구단',
    '서울시청',
    '세종스포츠토토여자축구단',
    '수원FC위민',
    '인천현대제철',
    '화천 KSPO 여자축구단',
  ],
  'SUFA-S': [
    '고려대 FC DREAM',
    '서울시립대 아마축구부',
    '숭실대 SSC',
    '연세대 FC연세',
    '연세대 WTF',
    '중앙대 청우회',
    '한양대 라이언',
    '한체대 태풍',
  ],
  'SUFA-A': [
    '고려대 아마추어축구부',
    '광운대 KWPE',
    '동국대 FC TOTO',
    '서울시립대 AZURE',
    '서강대 서강축구반',
    '중앙대 FC BASTARD',
    '한체대 FC LABAMBA',
    '한체대 FC 리히트',
  ],
  'SUFA-B': [
    '건국대 N:TROPY',
    '상명대 캐논',
    '서강대 KLASSIKER',
    '서울과기대 FC CTRL',
    '서울과기대 FC GAIA',
    '성균관대 성균축구단',
    '한국외대 야생마FC',
    '한양대 한백사',
  ],
  'SUFA-L': [
    '고려대 FC ELISE',
    '국민대 한마음 레이디스',
    '동국대 FC 엘레펜테',
    '서울대 SNUWFC',
    '서울시립대 WFC.BETA',
    '숙명여대 FC숙명',
    '연세대 W-KICKS',
    '이화여대 ESSA',
    '이화여대 FC콕',
    '한체대 FC천마',
  ],
};

function TeamCombobox({
  value,
  onSelect,
  options,
  disabledOption,
  placeholder,
}: {
  value: string;
  onSelect: (team: string) => void;
  options: string[];
  disabledOption?: string;
  placeholder: string;
}) {
  // query === null means "not searching": the input shows the selected value.
  const [query, setQuery] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  const filtered = useMemo(() => {
    const q = (query ?? '').trim().toLowerCase();
    if (!q) return options;
    return options.filter((team) => team.toLowerCase().includes(q));
  }, [options, query]);

  const close = () => {
    setIsOpen(false);
    setQuery(null);
    setHighlight(0);
  };

  const commit = (team: string) => {
    if (team === disabledOption) return;
    onSelect(team);
    close();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIsOpen(true);
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      if (!isOpen) return;
      e.preventDefault();
      const team = filtered[highlight];
      if (team) commit(team);
    } else if (e.key === 'Escape') {
      close();
    }
  };

  return (
    <div className="team-combobox">
      <input
        value={query ?? value}
        placeholder={placeholder}
        onFocus={() => setIsOpen(true)}
        onBlur={close}
        onKeyDown={handleKeyDown}
        onChange={(e) => {
          setQuery(e.target.value);
          setIsOpen(true);
          setHighlight(0);
        }}
      />
      {isOpen ? (
        <div className="team-combobox-list" onMouseDown={(e) => e.preventDefault()}>
          {filtered.length ? (
            filtered.map((team, index) => (
              <button
                key={team}
                type="button"
                disabled={team === disabledOption}
                className={`team-combobox-option${index === highlight ? ' highlighted' : ''}${team === value ? ' selected' : ''}`}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => commit(team)}
              >
                {team}
              </button>
            ))
          ) : (
            <div className="team-combobox-empty">검색 결과 없음</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default function Dashboard() {
  const PAGE_SIZE = 7;
  const { sport } = useSportContext();
  const [matches, setMatches] = useState<Match[]>([]);
  const [competitionClasses, setCompetitionClasses] = useState<CompetitionClass[]>([]);
  const [runningMatchIds, setRunningMatchIds] = useState<string[]>([]);
  const [homeTeam, setHomeTeam] = useState('');
  const [awayTeam, setAwayTeam] = useState('');
  const [competitionClass, setCompetitionClass] = useState('K3');
  const [roundNumber, setRoundNumber] = useState(1);
  const [streamMode, setStreamMode] = useState<'STREAM' | 'MANUAL'>('STREAM');
  const [basketballPeriodCount, setBasketballPeriodCount] = useState(4);
  const [basketballPeriodMinutes, setBasketballPeriodMinutes] = useState(10);
  const [assignOperator, setAssignOperator] = useState(false);
  const [ingestProtocol, setIngestProtocol] = useState<'SRT' | 'RTMP'>('RTMP');
  const [error, setError] = useState('');
  const [listMode, setListMode] = useState<'active' | 'archived'>('active');
  const [classFilter, setClassFilter] = useState('ALL');
  const [activePage, setActivePage] = useState(1);
  const [archivedPage, setArchivedPage] = useState(1);
  const [isClassModalOpen, setIsClassModalOpen] = useState(false);
  const [classModalMode, setClassModalMode] = useState<'create' | 'edit'>('create');
  const [newClassCode, setNewClassCode] = useState('');
  const [newClassName, setNewClassName] = useState('');
  const [newClassFirstHalf, setNewClassFirstHalf] = useState(45);
  const [newClassSecondHalf, setNewClassSecondHalf] = useState(45);
  const [newClassExtraFirstHalf, setNewClassExtraFirstHalf] = useState(15);
  const [newClassExtraSecondHalf, setNewClassExtraSecondHalf] = useState(15);
  const [editingClassCode, setEditingClassCode] = useState('');
  const [editingClassName, setEditingClassName] = useState('');
  const [editingClassFirstHalf, setEditingClassFirstHalf] = useState(45);
  const [editingClassSecondHalf, setEditingClassSecondHalf] = useState(45);
  const [editingClassExtraFirstHalf, setEditingClassExtraFirstHalf] = useState(15);
  const [editingClassExtraSecondHalf, setEditingClassExtraSecondHalf] = useState(15);
  const [classModalError, setClassModalError] = useState('');
  const [classModalNotice, setClassModalNotice] = useState('');
  const [importingClassTeams, setImportingClassTeams] = useState('');
  const [sessionUser, setSessionUser] = useState<SessionUser | null>(null);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [selectedDate, setSelectedDate] = useState(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  });
  const [scheduleEntries, setScheduleEntries] = useState<ScheduleEntry[]>([]);
  const [scheduleError, setScheduleError] = useState('');
  const [scheduleNotice, setScheduleNotice] = useState('');
  const [scheduleFile, setScheduleFile] = useState<File | null>(null);
  const [replaceSchedule, setReplaceSchedule] = useState(false);
  const [editingScheduleId, setEditingScheduleId] = useState<string | null>(null);
  const [isScheduleModalOpen, setIsScheduleModalOpen] = useState(false);
  const [isScheduleImportOpen, setIsScheduleImportOpen] = useState(false);
  const [scheduleForm, setScheduleForm] = useState<ScheduleForm>({
    league: 'K3',
    round_label: '',
    match_date: selectedDate,
    kickoff_time: '19:00',
    home_team: '',
    away_team: '',
    fla_staff: '',
    fpa_home_staff: '',
    fpa_away_staff: '',
  });

  const load = async () => {
    try {
      const [matchesData, classData, streamStatusData, scheduleData] = await Promise.all([
        apiJson<Match[]>(`/matches?sport=${sport}&include_fpa_manual=false&compact=true`),
        apiJson<CompetitionClass[]>('/competition-classes'),
        apiJson<StreamStatus>('/admin/streams/status').catch(() => ({ running_match_ids: [] })),
        apiJson<ScheduleEntry[]>('/schedule-entries').catch(() => []),
      ]);
      setMatches(Array.isArray(matchesData) ? matchesData : []);
      setCompetitionClasses(Array.isArray(classData) ? classData : []);
      setRunningMatchIds(Array.isArray(streamStatusData.running_match_ids) ? streamStatusData.running_match_ids : []);
      setScheduleEntries(Array.isArray(scheduleData) ? scheduleData : []);
      setError('');
    } catch (loadError) {
      setMatches([]);
      setRunningMatchIds([]);
      setError(loadError instanceof Error ? loadError.message : 'API unavailable. Run API server or infra/app compose stack.');
    }
  };

  useEffect(() => {
    load();
    // 목록은 가벼운 compact 응답만 받는다. 5초 주기면 운영 상태를 보기에 충분하면서
    // 여러 탭이 열려도 아카이브·에셋 metadata를 반복 전송/렌더하지 않는다.
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [sport]);

  useEffect(() => {
    apiJson<SessionUser>('/session/me')
      .then(setSessionUser)
      .catch(() => setSessionUser(null));
  }, []);

  const isSuperuser = sessionUser?.role === 'SUPERADMIN';

  useEffect(() => {
    if (!editingScheduleId) {
      setScheduleForm((current) => ({ ...current, match_date: selectedDate }));
    }
  }, [selectedDate, editingScheduleId]);

  const generatedMatchName = useMemo(() => {
    const home = homeTeam.trim();
    const away = awayTeam.trim();
    if (!home || !away) return '';
    if (sport === 'BASKETBALL') return `[BASKETBALL | ${roundNumber}R] ${home} vs ${away}`;
    return `[${competitionClass} | ${roundNumber}R] ${home} vs ${away}`;
  }, [sport, competitionClass, roundNumber, homeTeam, awayTeam]);

  const createMatch = async () => {
    if (!homeTeam.trim() || !awayTeam.trim()) {
      setError('홈팀과 어웨이팀을 모두 선택하거나 입력하세요.');
      return;
    }
    if (homeTeam.trim() === awayTeam.trim()) {
      setError('홈팀과 어웨이팀은 서로 달라야 합니다.');
      return;
    }
    setError('');

    const response = await apiFetch('/matches', {
      method: 'POST',
      body: JSON.stringify({
        name: generatedMatchName,
        sport,
        competition_class: sport === 'BASKETBALL' ? 'BASKETBALL' : competitionClass,
        round_number: roundNumber,
        stream_mode: sport === 'BASKETBALL' ? 'MANUAL' : streamMode,
        assign_operator: assignOperator,
        ingest_protocol: sport === 'FOOTBALL' && streamMode === 'STREAM' ? ingestProtocol : null,
        metadata: sport === 'BASKETBALL'
          ? {
              period_count: basketballPeriodCount,
              period_minutes: basketballPeriodMinutes,
              shot_clock_seconds: 24,
            }
          : undefined,
      }),
    });

    if (!response.ok) {
      setError((await response.text()) || 'Failed to create match');
      return;
    }

    setHomeTeam('');
    setAwayTeam('');
    setCompetitionClass('K3');
    setRoundNumber(1);
    setStreamMode('STREAM');
    setBasketballPeriodCount(4);
    setBasketballPeriodMinutes(10);
    setAssignOperator(false);
    setIngestProtocol('RTMP');
    await load();
  };

  const handleCompetitionClassChange = (nextClass: string) => {
    setCompetitionClass(nextClass);
    setHomeTeam('');
    setAwayTeam('');
  };

  const openCompetitionClassModal = () => {
    setClassModalMode('create');
    setClassModalError('');
    setClassModalNotice('');
    setIsClassModalOpen(true);
  };

  const createCompetitionClass = async () => {
    const code = newClassCode.trim().toUpperCase();
    const name = newClassName.trim() || code;
    if (!code) {
      setClassModalError('대회 코드를 입력하세요.');
      return;
    }
    if (!/^[A-Z0-9가-힣-]+$/.test(code)) {
      setClassModalError("대회 코드는 한글, 영문 대문자, 숫자, '-'만 사용할 수 있습니다. 괄호는 표시 이름에서 사용하세요.");
      return;
    }
    setClassModalError('');

    const response = await apiFetch('/competition-classes', {
      method: 'POST',
      body: JSON.stringify({
        code,
        name,
        first_half_minutes: newClassFirstHalf,
        second_half_minutes: newClassSecondHalf,
        extra_first_half_minutes: newClassExtraFirstHalf,
        extra_second_half_minutes: newClassExtraSecondHalf,
      }),
    });

    if (!response.ok) {
      setClassModalError((await response.text()) || 'Failed to create competition class');
      return;
    }

    setCompetitionClass(code);
    setNewClassCode('');
    setNewClassName('');
    setNewClassFirstHalf(45);
    setNewClassSecondHalf(45);
    setNewClassExtraFirstHalf(15);
    setNewClassExtraSecondHalf(15);
    setIsClassModalOpen(false);
    await load();
  };

  const startEditCompetitionClass = (item: CompetitionClass) => {
    setClassModalError('');
    setClassModalNotice('');
    setClassModalMode('edit');
    setEditingClassCode(item.code);
    setEditingClassName(item.name);
    setEditingClassFirstHalf(item.first_half_minutes);
    setEditingClassSecondHalf(item.second_half_minutes);
    setEditingClassExtraFirstHalf(item.extra_first_half_minutes ?? 15);
    setEditingClassExtraSecondHalf(item.extra_second_half_minutes ?? 15);
  };

  const cancelEditCompetitionClass = () => {
    setEditingClassCode('');
    setEditingClassName('');
    setEditingClassFirstHalf(45);
    setEditingClassSecondHalf(45);
    setEditingClassExtraFirstHalf(15);
    setEditingClassExtraSecondHalf(15);
    setClassModalError('');
    setClassModalNotice('');
  };

  const switchCompetitionClassMode = (mode: 'create' | 'edit') => {
    setClassModalMode(mode);
    setClassModalError('');
    setClassModalNotice('');
    if (mode === 'create') cancelEditCompetitionClass();
  };

  const updateCompetitionClass = async () => {
    if (!editingClassCode) return;
    const name = editingClassName.trim() || editingClassCode;
    setClassModalError('');

    const response = await apiFetch(`/competition-classes/${encodeURIComponent(editingClassCode)}`, {
      method: 'PUT',
      body: JSON.stringify({
        name,
        first_half_minutes: editingClassFirstHalf,
        second_half_minutes: editingClassSecondHalf,
        extra_first_half_minutes: editingClassExtraFirstHalf,
        extra_second_half_minutes: editingClassExtraSecondHalf,
      }),
    });

    if (!response.ok) {
      setClassModalError((await response.text()) || 'Failed to update competition class');
      return;
    }

    const updatedCode = editingClassCode;
    cancelEditCompetitionClass();
    setClassModalNotice(`${updatedCode} 대회 정보를 수정했습니다.`);
    await load();
  };

  const deleteCompetitionClass = async (item: CompetitionClass) => {
    if (!window.confirm(`${item.code} 대회를 삭제할까요? 되돌릴 수 없습니다.`)) return;
    setClassModalError('');
    setClassModalNotice('');

    const response = await apiFetch(`/competition-classes/${encodeURIComponent(item.code)}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      if (response.status === 409) {
        window.alert(`${item.code} 대회로 만든 경기가 있어 삭제할 수 없습니다.\n해당 대회의 경기가 하나도 없어야 삭제할 수 있습니다.`);
        return;
      }
      setClassModalError((await response.text()) || '대회를 삭제하지 못했습니다.');
      return;
    }

    if (editingClassCode === item.code) cancelEditCompetitionClass();
    if (competitionClass === item.code) handleCompetitionClassChange('K3');
    setClassModalNotice(`${item.code} 대회를 삭제했습니다.`);
    await load();
  };

  const downloadCompetitionTeams = async (item: CompetitionClass) => {
    setClassModalError('');
    setClassModalNotice('');
    const response = await fetch(`${API_BASE}/competition-classes/${encodeURIComponent(item.code)}/teams.csv`, {
      credentials: 'include',
    });
    if (!response.ok) {
      setClassModalError((await response.text()) || '팀 목록을 다운로드하지 못했습니다.');
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${item.code}_teams.csv`;
    link.click();
    URL.revokeObjectURL(url);
    setClassModalNotice(`${item.code} 팀 목록을 다운로드했습니다.`);
  };

  const importCompetitionTeams = async (item: CompetitionClass, file: File | null) => {
    if (!file) return;
    setClassModalError('');
    setClassModalNotice('');
    setImportingClassTeams(item.code);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const response = await fetch(`${API_BASE}/competition-classes/${encodeURIComponent(item.code)}/teams/import-csv`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      const text = await response.text();
      if (!response.ok) {
        setClassModalError(text || '팀 목록 업로드에 실패했습니다.');
        return;
      }
      const result = text ? JSON.parse(text) : { team_count: 0 };
      setClassModalNotice(`${item.code} 팀 목록 ${result.team_count || 0}개를 등록했습니다.`);
      if (competitionClass === item.code) {
        setHomeTeam('');
        setAwayTeam('');
      }
      await load();
    } catch (loadError) {
      setClassModalError(loadError instanceof Error ? loadError.message : '팀 목록 업로드에 실패했습니다.');
    } finally {
      setImportingClassTeams('');
    }
  };

  const resetScheduleForm = (date = selectedDate) => {
    setEditingScheduleId(null);
    setScheduleForm({
      league: competitionClass || 'K3',
      round_label: String(roundNumber || ''),
      match_date: date,
      kickoff_time: '19:00',
      home_team: '',
      away_team: '',
      fla_staff: '',
      fpa_home_staff: '',
      fpa_away_staff: '',
    });
  };

  const updateScheduleField = (key: keyof ScheduleForm, value: string) => {
    setScheduleForm((current) => ({ ...current, [key]: value }));
  };

  const openCreateSchedule = () => {
    resetScheduleForm(selectedDate);
    setScheduleError('');
    setScheduleNotice('');
    setIsScheduleModalOpen(true);
  };

  const closeScheduleModal = () => {
    setIsScheduleModalOpen(false);
    setScheduleError('');
    resetScheduleForm();
  };

  const startEditSchedule = (entry: ScheduleEntry) => {
    setEditingScheduleId(entry.id);
    setScheduleError('');
    setScheduleNotice('');
    setScheduleForm({
      league: entry.league,
      round_label: entry.round_label,
      match_date: entry.match_date,
      kickoff_time: entry.kickoff_time,
      home_team: entry.home_team,
      away_team: entry.away_team,
      fla_staff: entry.fla_staff,
      fpa_home_staff: entry.fpa_home_staff,
      fpa_away_staff: entry.fpa_away_staff,
    });
    setIsScheduleModalOpen(true);
  };

  const openScheduleImport = () => {
    setScheduleError('');
    setScheduleNotice('');
    setIsScheduleImportOpen(true);
  };

  const closeScheduleImport = () => {
    setIsScheduleImportOpen(false);
    setScheduleFile(null);
    setReplaceSchedule(false);
    setScheduleError('');
  };

  const saveScheduleEntry = async () => {
    if (!scheduleForm.match_date || !scheduleForm.kickoff_time || !scheduleForm.home_team.trim() || !scheduleForm.away_team.trim()) {
      setScheduleError('날짜, 시간, 홈팀, 어웨이팀은 필수입니다.');
      return;
    }
    setScheduleError('');
    setScheduleNotice('');

    const response = await apiFetch(editingScheduleId ? `/schedule-entries/${editingScheduleId}` : '/schedule-entries', {
      method: editingScheduleId ? 'PUT' : 'POST',
      body: JSON.stringify(scheduleForm),
    });
    if (!response.ok) {
      setScheduleError((await response.text()) || '일정을 저장하지 못했습니다.');
      return;
    }
    setScheduleNotice(editingScheduleId ? '일정을 수정했습니다.' : '일정을 추가했습니다.');
    setSelectedDate(scheduleForm.match_date);
    setCalendarMonth(new Date(`${scheduleForm.match_date}T00:00:00`));
    setIsScheduleModalOpen(false);
    resetScheduleForm(scheduleForm.match_date);
    await load();
  };

  const deleteScheduleEntry = async (entry: ScheduleEntry) => {
    const ok = window.confirm(`${entry.kickoff_time} ${entry.home_team} vs ${entry.away_team} 일정을 삭제할까요?`);
    if (!ok) return;
    setScheduleError('');
    setScheduleNotice('');
    const response = await apiFetch(`/schedule-entries/${entry.id}`, { method: 'DELETE' });
    if (!response.ok) {
      setScheduleError((await response.text()) || '일정을 삭제하지 못했습니다.');
      return;
    }
    setScheduleNotice('일정을 삭제했습니다.');
    if (editingScheduleId === entry.id) resetScheduleForm();
    await load();
  };

  const importScheduleCsv = async () => {
    if (!scheduleFile) {
      setScheduleError('업로드할 CSV 파일을 선택하세요.');
      return;
    }
    setScheduleError('');
    setScheduleNotice('');
    const formData = new FormData();
    formData.append('file', scheduleFile);
    const response = await fetch(`${API_BASE}/schedule-entries/import-csv?replace_existing=${replaceSchedule ? 'true' : 'false'}`, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    });
    const text = await response.text();
    if (!response.ok) {
      setScheduleError(text || 'CSV 업로드에 실패했습니다.');
      return;
    }
    const result = text ? JSON.parse(text) : { imported: 0, created: 0, updated: 0 };
    setScheduleNotice(`CSV 반영 완료: ${result.imported}행 · 신규 ${result.created} · 수정 ${result.updated}`);
    closeScheduleImport();
    await load();
  };

  const downloadScheduleTemplate = () => {
    const csv = `리그,라운드,날짜,시간,홈팀,어웨이팀,FLA담당자,FPA(홈),FPA(어웨이)\nK3,1,2026-07-04,19:00,홈팀명,어웨이팀명,FLA담당자,FPA홈담당자,FPA어웨이담당자\n`;
    const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'fpc_schedule_template.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  const deleteMatch = async (matchId: string, matchName: string) => {
    const ok = window.confirm(`Delete match '${matchName}'? This removes states/events/dominance data.`);
    if (!ok) return;

    setError('');
    let response = await apiFetch(`/matches/${matchId}?stop_stream=true`, {
      method: 'DELETE',
    });

    if (response.status === 409) {
      const detail = await response.text();
      const confirmLive = window.confirm(`${detail}\n\n계속 삭제할까요?`);
      if (!confirmLive) return;
      response = await apiFetch(`/matches/${matchId}?stop_stream=true&confirm_live_action=true`, {
        method: 'DELETE',
      });
    }

    if (!response.ok) {
      setError((await response.text()) || 'Failed to delete match');
      return;
    }

    await load();
  };

  const setArchived = async (matchId: string, archived: boolean) => {
    const prompt = archived
      ? '이 경기를 보관할까요? 보관 후에는 상세 페이지가 read-only가 됩니다.'
      : '이 경기를 다시 운영 목록으로 복원할까요?';
    if (!window.confirm(prompt)) return;

    setError('');
    let response = await apiFetch(`/matches/${matchId}/archive`, {
      method: 'POST',
      body: JSON.stringify({
        archived,
        stop_stream: archived,
      }),
    });

    if (response.status === 409) {
      const detail = await response.text();
      const confirmLive = window.confirm(`${detail}\n\n계속 진행할까요?`);
      if (!confirmLive) return;
      response = await apiFetch(`/matches/${matchId}/archive?confirm_live_action=true`, {
        method: 'POST',
        body: JSON.stringify({
          archived,
          stop_stream: archived,
        }),
      });
    }

    if (!response.ok) {
      setError((await response.text()) || (archived ? 'Failed to archive match' : 'Failed to restore match'));
      return;
    }

    await load();
  };

  const monthLabel = `${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth() + 1).padStart(2, '0')}`;
  const firstDay = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
  const lastDay = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0);
  const startWeekday = firstDay.getDay();
  const dayCount = lastDay.getDate();

  const visibleScheduleItems = sport === 'FOOTBALL' ? scheduleEntries : [];

  const countByDate = visibleScheduleItems.reduce<Record<string, number>>((acc, item) => {
    if (!item.match_date) return acc;
    acc[item.match_date] = (acc[item.match_date] || 0) + 1;
    return acc;
  }, {});

  const selectedMatches = visibleScheduleItems
    .filter((item) => item.match_date === selectedDate)
    .sort((a, b) => a.kickoff_time.localeCompare(b.kickoff_time));

  const dayCells: Array<number | null> = [];
  for (let i = 0; i < startWeekday; i += 1) dayCells.push(null);
  for (let day = 1; day <= dayCount; day += 1) dayCells.push(day);
  while (dayCells.length % 7 !== 0) dayCells.push(null);

  const liveCount = runningMatchIds.length;
  const selectedCompetition = useMemo(
    () => competitionClasses.find((item) => item.code === competitionClass),
    [competitionClasses, competitionClass]
  );
  const competitionOptions = useMemo(() => {
    if (competitionClasses.length > 0) return competitionClasses;
    return [
      { code: 'K3', name: 'K3', first_half_minutes: 45, second_half_minutes: 45, created_at: '' },
      { code: 'WK', name: 'WK', first_half_minutes: 45, second_half_minutes: 45, created_at: '' },
      { code: 'CUSTOM', name: 'CUSTOM', first_half_minutes: 45, second_half_minutes: 45, created_at: '' },
      { code: 'SUFA-S', name: 'SUFA-S', first_half_minutes: 20, second_half_minutes: 20, created_at: '' },
      { code: 'SUFA-A', name: 'SUFA-A', first_half_minutes: 20, second_half_minutes: 20, created_at: '' },
      { code: 'SUFA-B', name: 'SUFA-B', first_half_minutes: 20, second_half_minutes: 20, created_at: '' },
      { code: 'SUFA-L', name: 'SUFA-L', first_half_minutes: 20, second_half_minutes: 20, created_at: '' },
    ];
  }, [competitionClasses]);
  // Sorted copy so the dropdown stays alphabetized no matter what order the
  // imported CSV/Excel sheet listed the teams in; re-sorts whenever the
  // competition's team list reloads after an upload.
  const selectedTeamOptions = useMemo(() => {
    const teams = selectedCompetition?.team_options?.length
      ? selectedCompetition.team_options
      : TEAM_OPTIONS_BY_CLASS[competitionClass] || [];
    return [...teams].sort((a, b) => a.localeCompare(b, 'ko'));
  }, [selectedCompetition, competitionClass]);
  const usesTeamDropdown = selectedTeamOptions.length > 0;
  const assignedCount = useMemo(() => matches.filter((match) => !match.archived && match.operator_id).length, [matches]);
  const rtmpCount = useMemo(
    () => matches.filter((match) => !match.archived && match.metadata?.ingest_protocol === 'RTMP').length,
    [matches]
  );
  const activeMatches = useMemo(
    () => matches.filter((match) => !match.archived),
    [matches]
  );
  const archivedMatches = useMemo(
    () => matches.filter((match) => match.archived),
    [matches]
  );
  const availableClasses = useMemo(() => {
    const classes = new Set([
      ...competitionOptions.map((item) => item.code),
      ...matches.map((match) => (match.competition_class || 'K3').toUpperCase()),
    ]);
    return ['ALL', ...Array.from(classes).sort()];
  }, [competitionOptions, matches]);
  const filteredActiveMatches = useMemo(
    () =>
      activeMatches.filter((match) => classFilter === 'ALL' || (match.competition_class || 'K3').toUpperCase() === classFilter),
    [activeMatches, classFilter]
  );
  const filteredArchivedMatches = useMemo(
    () =>
      archivedMatches.filter((match) => classFilter === 'ALL' || (match.competition_class || 'K3').toUpperCase() === classFilter),
    [archivedMatches, classFilter]
  );
  const pagedActiveMatches = useMemo(
    () => filteredActiveMatches.slice((activePage - 1) * PAGE_SIZE, activePage * PAGE_SIZE),
    [filteredActiveMatches, activePage]
  );
  const pagedArchivedMatches = useMemo(
    () => filteredArchivedMatches.slice((archivedPage - 1) * PAGE_SIZE, archivedPage * PAGE_SIZE),
    [filteredArchivedMatches, archivedPage]
  );
  const activePageCount = Math.max(1, Math.ceil(filteredActiveMatches.length / PAGE_SIZE));
  const archivedPageCount = Math.max(1, Math.ceil(filteredArchivedMatches.length / PAGE_SIZE));

  useEffect(() => {
    setActivePage(1);
    setArchivedPage(1);
  }, [classFilter, listMode, sport]);

  useEffect(() => {
    if (activePage > activePageCount) setActivePage(activePageCount);
  }, [activePage, activePageCount]);

  useEffect(() => {
    if (archivedPage > archivedPageCount) setArchivedPage(archivedPageCount);
  }, [archivedPage, archivedPageCount]);

  const visibleMatches = listMode === 'active' ? pagedActiveMatches : pagedArchivedMatches;
  const currentPage = listMode === 'active' ? activePage : archivedPage;
  const currentPageCount = listMode === 'active' ? activePageCount : archivedPageCount;
  const setCurrentPage = (nextPage: number) => {
    if (listMode === 'active') {
      setActivePage(nextPage);
      return;
    }
    setArchivedPage(nextPage);
  };

  return (
    <>
      <main className="page-stack">
        <section className="page-hero">
          <div className="hero-grid">
            <div className="card card-hero grid hero-card-compact">
              <div className="section-heading">
                <div>
                  <div className="sidebar-eyebrow">Overview</div>
                  <h2>{sport === 'BASKETBALL' ? '농구 운영 대시보드' : '운영 대시보드'}</h2>
                </div>
                <span className="status-pill running">Live {liveCount}</span>
              </div>
              <div className="metric-strip metric-strip-overview">
                <div className="metric-tile success">
                  <span className="muted">Total Matches</span>
                  <strong>{matches.length}</strong>
                </div>
                <div className="metric-tile tech">
                  <span className="muted">Archived</span>
                  <strong>{archivedMatches.length}</strong>
                </div>
                <div className="metric-tile">
                  <span className="muted">Assigned</span>
                  <strong>{assignedCount}</strong>
                </div>
                <div className="metric-tile">
                  <span className="muted">RTMP Pipelines</span>
                  <strong>{sport === 'FOOTBALL' ? rtmpCount : 0}</strong>
                </div>
              </div>
            </div>

            <div className="card card-panel grid hero-card-wide">
              <div className="section-heading">
                <div>
                  <div className="sidebar-eyebrow">Create Match</div>
                  <h3>{sport === 'BASKETBALL' ? '농구 경기 등록' : '새 경기 등록'}</h3>
                </div>
                {sport === 'FOOTBALL' ? <button className="button-compact btn-secondary" onClick={openCompetitionClassModal}>
                  대회 관리
                </button> : null}
              </div>
              <div className={`hero-form-grid compact ${sport === 'BASKETBALL' ? 'basketball-create-form' : ''}`}>
                {sport === 'FOOTBALL' ? <div className="field-stack field-stack-short">
                  <div className="field-label">대회</div>
                  <select value={competitionClass} onChange={(e) => handleCompetitionClassChange(e.target.value)}>
                    {competitionOptions.map((item) => (
                      <option key={item.code} value={item.code}>
                        {item.code}
                      </option>
                    ))}
                  </select>
                </div> : null}

                <div className="field-stack field-stack-round">
                  <div className="field-label">라운드</div>
                  <input
                    min={1}
                    step={1}
                    type="number"
                    value={roundNumber}
                    onChange={(e) => setRoundNumber(Math.max(1, Number(e.target.value) || 1))}
                  />
                </div>

                <div className="field-stack field-stack-wide">
                  <div className="field-label">홈</div>
                  {sport === 'FOOTBALL' && usesTeamDropdown ? (
                    <TeamCombobox
                      value={homeTeam}
                      onSelect={setHomeTeam}
                      options={selectedTeamOptions}
                      disabledOption={awayTeam || undefined}
                      placeholder="홈팀 선택 · 검색"
                    />
                  ) : (
                    <input value={homeTeam} onChange={(e) => setHomeTeam(e.target.value)} placeholder={sport === 'BASKETBALL' ? '예: Home Hoops' : '예: 당진'} />
                  )}
                </div>

                <div className="field-stack field-stack-wide">
                  <div className="field-label">어웨이</div>
                  {sport === 'FOOTBALL' && usesTeamDropdown ? (
                    <TeamCombobox
                      value={awayTeam}
                      onSelect={setAwayTeam}
                      options={selectedTeamOptions}
                      disabledOption={homeTeam || undefined}
                      placeholder="어웨이팀 선택 · 검색"
                    />
                  ) : (
                    <input value={awayTeam} onChange={(e) => setAwayTeam(e.target.value)} placeholder={sport === 'BASKETBALL' ? '예: Away Five' : '예: 경주'} />
                  )}
                </div>

                {sport === 'FOOTBALL' ? <div className="field-stack field-stack-short">
                  <div className="field-label">운영모드</div>
                  <select value={streamMode} onChange={(e) => setStreamMode(e.target.value as 'STREAM' | 'MANUAL')}>
                    <option value="STREAM">STREAM</option>
                    <option value="MANUAL">MANUAL</option>
                  </select>
                </div> : null}

                {sport === 'FOOTBALL' ? <div className="field-stack field-stack-short">
                  <div className="field-label">프로토콜</div>
                  <select value={ingestProtocol} onChange={(e) => setIngestProtocol(e.target.value as 'SRT' | 'RTMP')} disabled={streamMode !== 'STREAM'}>
                    <option value="RTMP">RTMP</option>
                    <option value="SRT">SRT</option>
                  </select>
                </div> : null}

                {sport === 'BASKETBALL' ? (
                  <>
                    <div className="field-stack field-stack-short">
                      <div className="field-label">쿼터 수</div>
                      <input
                        min={1}
                        max={8}
                        step={1}
                        type="number"
                        value={basketballPeriodCount}
                        onChange={(e) => setBasketballPeriodCount(Math.max(1, Math.min(8, Number(e.target.value) || 4)))}
                      />
                    </div>
                    <div className="field-stack field-stack-short">
                      <div className="field-label">쿼터 시간</div>
                      <input
                        min={1}
                        max={15}
                        step={1}
                        type="number"
                        value={basketballPeriodMinutes}
                        onChange={(e) => setBasketballPeriodMinutes(Math.max(1, Math.min(15, Number(e.target.value) || 10)))}
                      />
                    </div>
                  </>
                ) : null}

                <div className="field-stack field-stack-operator">
                  <div className="field-label">operator 상속</div>
                  <label className="row operator-toggle-inline">
                    <input
                      type="checkbox"
                      checked={assignOperator}
                      onChange={(e) => setAssignOperator(e.target.checked)}
                      style={{ minHeight: 'auto', width: 18, height: 18 }}
                    />
                    <span>현재 계정 사용</span>
                  </label>
                </div>

                <div className="field-stack field-stack-generated">
                  <div className="field-label">생성이름</div>
                  <div className="kbd dashboard-generated-name">
                    {generatedMatchName || (sport === 'BASKETBALL' ? `[BASKETBALL | ${roundNumber}R] 홈팀 vs 어웨이팀` : `[${competitionClass} | ${roundNumber}R] 홈팀 vs 어웨이팀`)}
                  </div>
                </div>
              </div>
              {sport === 'FOOTBALL' ? <div className="muted dashboard-class-time">
                경기 시간: 전반 {selectedCompetition?.first_half_minutes || 45}분 / 후반 {selectedCompetition?.second_half_minutes || 45}분
              </div> : (
                <div className="muted dashboard-class-time">
                  경기 시간: {basketballPeriodCount}Q × {basketballPeriodMinutes}분 · 수동 기록 MVP
                </div>
              )}
              <div className="row hero-actions-compact">
                <button className="btn-primary" onClick={createMatch}>Create Match</button>
              </div>
              {error ? <p className="form-error" style={{ margin: 0 }}>{error}</p> : null}
            </div>
          </div>
        </section>

        <section className="dashboard-grid">
          <div className="card card-panel">
            <div className="section-heading">
              <div>
                <div className="sidebar-eyebrow">Match List</div>
                <h3>{listMode === 'active' ? '운영 중인 매치' : '보관 매치'}</h3>
              </div>
            </div>

            <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 16 }}>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button className={listMode === 'active' ? 'btn-active' : ''} onClick={() => setListMode('active')}>Active</button>
                <button className={listMode === 'archived' ? 'btn-active' : ''} onClick={() => setListMode('archived')}>Archived</button>
              </div>
              <div className="field-stack dashboard-filter-select">
                <span className="field-label">{sport === 'BASKETBALL' ? '종목 필터' : '대회 필터'}</span>
                <select value={classFilter} onChange={(event) => setClassFilter(event.target.value)}>
                  {availableClasses.map((itemClass) => (
                    <option key={itemClass} value={itemClass}>
                      {itemClass === 'ALL' ? '전체' : itemClass}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="match-list">
              {visibleMatches.map((match) => {
                const isRunning = runningMatchIds.includes(match.id);
                return (
                  <div key={match.id} className="match-item">
                    <div className="grid match-item-main" style={{ gap: 8 }}>
                      <div className="row" style={{ flexWrap: 'wrap' }}>
                        <strong style={{ fontSize: 18 }}>{match.name}</strong>
                        <span className="status-pill">{match.competition_class || 'K3'}</span>
                        <span className="status-pill tech">{match.sport === 'BASKETBALL' ? 'BASKETBALL' : 'FOOTBALL'}</span>
                        <span className="status-pill warning">R{match.round_number || 1}</span>
                        <span className={`status-pill ${match.archived ? 'archived' : isRunning ? 'running' : 'stopped'}`}>
                          {match.archived ? 'ARCHIVED' : isRunning ? 'RUNNING' : 'STOPPED'}
                        </span>
                      </div>
                      <div className="muted">operator: {match.operator_id || 'unassigned'}</div>
                      <div className="match-meta-group">
                        <span className={`meta-chip ${match.metadata?.stream_mode === 'MANUAL' ? 'warning' : ''}`}>
                          mode: {match.sport === 'BASKETBALL' ? 'manual court' : match.metadata?.stream_mode === 'MANUAL' ? 'manual field' : 'stream'}
                        </span>
                        <span className={`meta-chip ${match.metadata?.ingest_protocol ? 'tech' : ''}`}>
                          protocol: {match.sport === 'BASKETBALL' ? 'n/a' : match.metadata?.ingest_protocol || 'not set'}
                        </span>
                        <span className={`meta-chip ${
                          match.sport === 'BASKETBALL' || match.metadata?.stream_mode === 'MANUAL'
                            ? ''
                            : match.hls_url
                              ? 'success'
                              : 'warning'
                        }`}>
                          {match.sport === 'BASKETBALL'
                            ? 'no stream'
                            : match.metadata?.stream_mode === 'MANUAL'
                            ? 'no hls'
                            : match.hls_url
                              ? 'hls ready'
                              : 'hls pending'}
                        </span>
                      </div>
                      <div className="muted">
                        created: {new Date(match.created_at).toLocaleString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' })}
                        {match.archived_at
                          ? ` / archived: ${new Date(match.archived_at).toLocaleString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' })}`
                          : ''}
                      </div>
                    </div>
                    <div className="match-actions">
                      <Link className="button-link button-compact btn-primary" href={match.sport === 'BASKETBALL' ? `/admin/basketball/match/${match.id}` : `/admin/match/${match.id}`}>
                        {match.archived ? 'Open Read-Only' : 'Open'}
                      </Link>
                      {match.archived ? (
                        <Link className="button-link button-compact btn-secondary" href={`/admin/match/${match.id}/edit`}>
                          Edit Events
                        </Link>
                      ) : null}
                      {match.archived ? (
                        <button className="button-compact btn-secondary" onClick={() => setArchived(match.id, false)}>Restore</button>
                      ) : (
                        <>
                          <button className="button-compact btn-secondary" onClick={() => setArchived(match.id, true)}>Archive</button>
                          <button className="btn-danger button-compact" onClick={() => deleteMatch(match.id, match.name)}>Delete</button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
              {(listMode === 'active' ? filteredActiveMatches.length : filteredArchivedMatches.length) === 0 ? (
                <div className="muted">
                  {listMode === 'active' ? 'No active matches for this class.' : 'No archived matches for this class.'}
                </div>
              ) : null}
            </div>

            {currentPageCount > 1 ? (
              <div className="pagination-bar">
                <button onClick={() => setCurrentPage(Math.max(1, currentPage - 1))} disabled={currentPage === 1}>
                  {'<'}
                </button>
                <div className="pagination-pages">
                  {Array.from({ length: currentPageCount }, (_, index) => {
                    const page = index + 1;
                    return (
                      <button
                        key={page}
                        className={page === currentPage ? 'btn-active' : ''}
                        onClick={() => setCurrentPage(page)}
                      >
                        {page}
                      </button>
                    );
                  })}
                </div>
                <button onClick={() => setCurrentPage(Math.min(currentPageCount, currentPage + 1))} disabled={currentPage === currentPageCount}>
                  {'>'}
                </button>
              </div>
            ) : null}
          </div>

          <div className="card card-utility">
              <div className="section-heading">
                <div>
                  <div className="sidebar-eyebrow">Schedule</div>
                  <h3>Match Calendar</h3>
                </div>
                <div className="row">
                  <button onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))}>
                    Prev
                  </button>
                  <strong style={{ minWidth: 90, textAlign: 'center' }}>{monthLabel}</strong>
                  <button onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))}>
                    Next
                  </button>
                </div>
              </div>

              <div className="calendar-grid">
                {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((weekday) => (
                  <div key={weekday} className="muted" style={{ textAlign: 'center', fontWeight: 700 }}>{weekday}</div>
                ))}

                {dayCells.map((day, index) => {
                  if (!day) return <div key={`empty-${index}`} />;

                  const dateKey = `${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                  const count = countByDate[dateKey] || 0;
                  const isSelected = selectedDate === dateKey;

                  return (
                    <button
                      key={dateKey}
                      className={`day-cell ${isSelected ? 'selected' : ''}`}
                      onClick={() => setSelectedDate(dateKey)}
                    >
                      <div style={{ fontWeight: 700 }}>{day}</div>
                      <div className="muted" style={{ color: count > 0 ? 'var(--accent)' : undefined }}>
                        {count > 0 ? `${count} match${count > 1 ? 'es' : ''}` : '-'}
                      </div>
                    </button>
                  );
                })}
              </div>

              <div style={{ marginTop: 16 }}>
                <div className="section-heading">
                  <div>
                    <div style={{ fontWeight: 700 }}>Fixtures on {selectedDate}</div>
                    <div className="muted">{selectedMatches.length} fixtures</div>
                  </div>
                  <div className="schedule-toolbar">
                    <button className="button-compact btn-secondary" onClick={downloadScheduleTemplate}>CSV 템플릿</button>
                    <button className="button-compact btn-secondary" onClick={openScheduleImport}>CSV 업로드</button>
                    <button className="button-compact btn-primary" onClick={openCreateSchedule}>일정 추가</button>
                  </div>
                </div>

                {scheduleError ? <p className="form-error">{scheduleError}</p> : null}
                {scheduleNotice ? <p className="muted">{scheduleNotice}</p> : null}

                {selectedMatches.length === 0 ? (
                  <div className="muted">No fixtures</div>
                ) : (
                  <div className="schedule-list">
                    {selectedMatches.map((item, index) => (
                      <div
                        key={item.id}
                        style={{
                          borderTop: index === 0 ? 'none' : '1px dashed var(--line-strong)',
                          marginTop: index === 0 ? 0 : 8,
                          paddingTop: index === 0 ? 0 : 8,
                        }}
                      >
                        <div className="section-heading schedule-item-heading">
                          <div>
                            <div style={{ fontWeight: 700 }}>{item.home_team} vs {item.away_team}</div>
                            <div className="muted">
                              {item.kickoff_time} | {item.league}{item.round_label ? ` ${item.round_label}R` : ''}
                            </div>
                          </div>
                          <div className="row">
                            <button className="button-compact btn-secondary" onClick={() => startEditSchedule(item)}>수정</button>
                            <button className="button-compact btn-danger" onClick={() => deleteScheduleEntry(item)}>삭제</button>
                          </div>
                        </div>
                        <div className="muted">FLA: {item.fla_staff || '-'}</div>
                        <div className="muted">FPA 홈: {item.fpa_home_staff || '-'}</div>
                        <div className="muted">FPA 어웨이: {item.fpa_away_staff || '-'}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
          </div>
        </section>
      </main>
      {isClassModalOpen ? (
        <div className="fcm-modal-backdrop" role="dialog" aria-modal="true" aria-label="대회 관리">
          <div className="card card-panel fcm-modal competition-modal">
            <div className="section-heading">
              <div>
                <div className="sidebar-eyebrow">Competition</div>
                <h3>대회 관리</h3>
              </div>
              <button className="button-compact btn-secondary" onClick={() => setIsClassModalOpen(false)}>닫기</button>
            </div>

            <div className="fpa-segmented competition-modal-tabs">
              <button
                className={classModalMode === 'create' ? 'active' : ''}
                onClick={() => switchCompetitionClassMode('create')}
              >
                생성
              </button>
              <button
                className={classModalMode === 'edit' ? 'active' : ''}
                onClick={() => switchCompetitionClassMode('edit')}
              >
                편집
              </button>
            </div>

            <div className="competition-modal-body">
              {classModalMode === 'create' ? (
                <div className="competition-modal-section">
                  <div className="competition-modal-grid">
                    <div className="field-stack">
                      <div className="field-label">대회 코드</div>
                      <input
                        value={newClassCode}
                        onChange={(e) => setNewClassCode(e.target.value.toUpperCase())}
                        maxLength={20}
                        placeholder="예: K3-4 또는 대학리그"
                      />
                      <small>한글·영문·숫자·하이픈(-)만 사용할 수 있습니다.</small>
                    </div>
                    <div className="field-stack">
                      <div className="field-label">표시 이름</div>
                      <input
                        value={newClassName}
                        onChange={(e) => setNewClassName(e.target.value)}
                        maxLength={60}
                        placeholder="예: K3리그 (챌린저)"
                      />
                      <small>한글과 괄호를 포함해 자유롭게 입력할 수 있습니다.</small>
                    </div>
                    <div className="field-stack">
                      <div className="field-label">전반 시간(분)</div>
                      <input
                        min={1}
                        max={120}
                        step={1}
                        type="number"
                        value={newClassFirstHalf}
                        onChange={(e) => setNewClassFirstHalf(Math.max(1, Math.min(120, Number(e.target.value) || 1)))}
                      />
                    </div>
                    <div className="field-stack">
                      <div className="field-label">후반 시간(분)</div>
                      <input
                        min={1}
                        max={120}
                        step={1}
                        type="number"
                        value={newClassSecondHalf}
                        onChange={(e) => setNewClassSecondHalf(Math.max(1, Math.min(120, Number(e.target.value) || 1)))}
                      />
                    </div>
                    <div className="field-stack">
                      <div className="field-label">연장 전반(분)</div>
                      <input
                        min={1}
                        max={120}
                        step={1}
                        type="number"
                        value={newClassExtraFirstHalf}
                        onChange={(e) => setNewClassExtraFirstHalf(Math.max(1, Math.min(120, Number(e.target.value) || 1)))}
                      />
                    </div>
                    <div className="field-stack">
                      <div className="field-label">연장 후반(분)</div>
                      <input
                        min={1}
                        max={120}
                        step={1}
                        type="number"
                        value={newClassExtraSecondHalf}
                        onChange={(e) => setNewClassExtraSecondHalf(Math.max(1, Math.min(120, Number(e.target.value) || 1)))}
                      />
                    </div>
                  </div>

                  {classModalError ? <p className="form-error" style={{ margin: 0 }}>{classModalError}</p> : null}
                  <div className="row hero-actions-compact">
                    <button className="btn-primary" onClick={createCompetitionClass}>Create Competition</button>
                  </div>
                </div>
              ) : (
                <div className="competition-modal-section">
                  <div className="fcm-guide-table-wrap competition-class-table-wrap">
                    <table className="fcm-guide-table competition-class-table">
                      <thead>
                        <tr>
                          <th>코드</th>
                          <th>이름</th>
                          <th>시간</th>
                          <th>팀</th>
                          <th>관리</th>
                        </tr>
                      </thead>
                      <tbody>
                        {competitionOptions.map((item) => (
                          <tr key={item.code}>
                            <td>{item.code}</td>
                            <td>{item.name}</td>
                            <td>{item.first_half_minutes} / {item.second_half_minutes}분</td>
                            <td>{item.team_options?.length || 0}팀</td>
                            <td>
                              <div className="competition-actions">
                                <button className="button-compact btn-secondary" onClick={() => startEditCompetitionClass(item)}>
                                  수정
                                </button>
                                <button className="button-compact btn-secondary" onClick={() => void downloadCompetitionTeams(item)}>
                                  다운로드
                                </button>
                                <label className={`button-compact btn-secondary competition-file-label ${importingClassTeams === item.code ? 'disabled' : ''}`}>
                                  {importingClassTeams === item.code ? '업로드 중' : '업로드'}
                                  <input
                                    accept=".csv,text/csv"
                                    disabled={Boolean(importingClassTeams)}
                                    type="file"
                                    onChange={(event) => {
                                      const input = event.currentTarget;
                                      const file = input.files?.[0] || null;
                                      void importCompetitionTeams(item, file).finally(() => {
                                        input.value = '';
                                      });
                                    }}
                                  />
                                </label>
                                {isSuperuser ? (
                                  <button className="button-compact btn-danger" onClick={() => void deleteCompetitionClass(item)}>
                                    삭제
                                  </button>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {editingClassCode ? (
                    <div className="competition-edit-panel">
                      <div className="section-heading">
                        <div>
                          <div className="sidebar-eyebrow">{editingClassCode}</div>
                          <h3>대회 정보 수정</h3>
                        </div>
                        <button className="button-compact btn-secondary" onClick={cancelEditCompetitionClass}>취소</button>
                      </div>
                      <div className="competition-modal-grid">
                        <div className="field-stack">
                          <div className="field-label">표시 이름</div>
                          <input
                            value={editingClassName}
                            onChange={(e) => setEditingClassName(e.target.value)}
                            maxLength={60}
                          />
                          <small>한글과 괄호를 포함해 자유롭게 입력할 수 있습니다.</small>
                        </div>
                        <div className="field-stack">
                          <div className="field-label">전반 시간(분)</div>
                          <input
                            min={1}
                            max={120}
                            step={1}
                            type="number"
                            value={editingClassFirstHalf}
                            onChange={(e) => setEditingClassFirstHalf(Math.max(1, Math.min(120, Number(e.target.value) || 1)))}
                          />
                        </div>
                        <div className="field-stack">
                          <div className="field-label">후반 시간(분)</div>
                          <input
                            min={1}
                            max={120}
                            step={1}
                            type="number"
                            value={editingClassSecondHalf}
                            onChange={(e) => setEditingClassSecondHalf(Math.max(1, Math.min(120, Number(e.target.value) || 1)))}
                          />
                        </div>
                        <div className="field-stack">
                          <div className="field-label">연장 전반(분)</div>
                          <input
                            min={1}
                            max={120}
                            step={1}
                            type="number"
                            value={editingClassExtraFirstHalf}
                            onChange={(e) => setEditingClassExtraFirstHalf(Math.max(1, Math.min(120, Number(e.target.value) || 1)))}
                          />
                        </div>
                        <div className="field-stack">
                          <div className="field-label">연장 후반(분)</div>
                          <input
                            min={1}
                            max={120}
                            step={1}
                            type="number"
                            value={editingClassExtraSecondHalf}
                            onChange={(e) => setEditingClassExtraSecondHalf(Math.max(1, Math.min(120, Number(e.target.value) || 1)))}
                          />
                        </div>
                        <div className="field-stack" style={{ justifyContent: 'end' }}>
                          <button className="btn-primary" onClick={updateCompetitionClass}>Save Changes</button>
                        </div>
                      </div>
                    </div>
                  ) : null}

                  {classModalError ? <p className="form-error" style={{ margin: 0 }}>{classModalError}</p> : null}
                  {classModalNotice ? <p className="muted" style={{ margin: 0 }}>{classModalNotice}</p> : null}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
      {isScheduleImportOpen ? (
        <div className="fcm-modal-backdrop" role="dialog" aria-modal="true" aria-label="CSV 일정 업로드">
          <div className="card card-panel fcm-modal schedule-modal schedule-import-modal">
            <div className="section-heading">
              <div>
                <div className="sidebar-eyebrow">Schedule</div>
                <h3>CSV 업로드</h3>
              </div>
              <button className="button-compact btn-secondary" onClick={closeScheduleImport}>닫기</button>
            </div>

            <div className="schedule-modal-body">
              <div className="schedule-import-panel">
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(event) => setScheduleFile(event.target.files?.[0] || null)}
                />
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={replaceSchedule}
                    onChange={(event) => setReplaceSchedule(event.target.checked)}
                  />
                  기존 일정 전체 교체
                </label>
              </div>

              {scheduleError ? <p className="form-error" style={{ margin: 0 }}>{scheduleError}</p> : null}

              <div className="row hero-actions-compact schedule-dialog-actions">
                <button className="button-compact btn-secondary" onClick={downloadScheduleTemplate}>CSV 템플릿</button>
                <button className="btn-primary" onClick={importScheduleCsv}>업로드</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {isScheduleModalOpen ? (
        <div className="fcm-modal-backdrop" role="dialog" aria-modal="true" aria-label={editingScheduleId ? '일정 수정' : '일정 추가'}>
          <div className="card card-panel fcm-modal schedule-modal">
            <div className="section-heading">
              <div>
                <div className="sidebar-eyebrow">Schedule</div>
                <h3>{editingScheduleId ? '일정 수정' : '일정 추가'}</h3>
              </div>
              <button className="button-compact btn-secondary" onClick={closeScheduleModal}>닫기</button>
            </div>

            <div className="schedule-modal-body">
              <div className="schedule-entry-form">
                <div className="field-stack">
                  <div className="field-label">리그</div>
                  <input value={scheduleForm.league} onChange={(event) => updateScheduleField('league', event.target.value)} />
                </div>
                <div className="field-stack">
                  <div className="field-label">라운드</div>
                  <input value={scheduleForm.round_label} onChange={(event) => updateScheduleField('round_label', event.target.value)} />
                </div>
                <div className="field-stack">
                  <div className="field-label">날짜</div>
                  <input type="date" value={scheduleForm.match_date} onChange={(event) => updateScheduleField('match_date', event.target.value)} />
                </div>
                <div className="field-stack">
                  <div className="field-label">시간</div>
                  <input type="time" value={scheduleForm.kickoff_time} onChange={(event) => updateScheduleField('kickoff_time', event.target.value)} />
                </div>
                <div className="field-stack">
                  <div className="field-label">홈팀</div>
                  <input value={scheduleForm.home_team} onChange={(event) => updateScheduleField('home_team', event.target.value)} />
                </div>
                <div className="field-stack">
                  <div className="field-label">어웨이팀</div>
                  <input value={scheduleForm.away_team} onChange={(event) => updateScheduleField('away_team', event.target.value)} />
                </div>
                <div className="field-stack">
                  <div className="field-label">FLA담당자</div>
                  <input value={scheduleForm.fla_staff} onChange={(event) => updateScheduleField('fla_staff', event.target.value)} />
                </div>
                <div className="field-stack">
                  <div className="field-label">FPA(홈)</div>
                  <input value={scheduleForm.fpa_home_staff} onChange={(event) => updateScheduleField('fpa_home_staff', event.target.value)} />
                </div>
                <div className="field-stack">
                  <div className="field-label">FPA(어웨이)</div>
                  <input value={scheduleForm.fpa_away_staff} onChange={(event) => updateScheduleField('fpa_away_staff', event.target.value)} />
                </div>
              </div>

              {scheduleError ? <p className="form-error" style={{ margin: 0 }}>{scheduleError}</p> : null}

              <div className="row hero-actions-compact schedule-dialog-actions">
                <button className="button-compact btn-secondary" onClick={closeScheduleModal}>취소</button>
                <button className="btn-primary" onClick={saveScheduleEntry}>{editingScheduleId ? '수정 저장' : '일정 추가'}</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
