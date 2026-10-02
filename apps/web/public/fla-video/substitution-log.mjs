// Video elapsed time only. This log is independent of tracker IDs and never
// renames a roster slot or changes historical tracking/heatmap assignments.
export const LOG_SCHEMA = 'fpa-substitution-log/v2';
export const hasPlayerPair = e => Boolean(e?.outId && e?.inId);
const assert = (ok, message) => { if (!ok) throw Error(message); };
const finite = n => typeof n === 'number' && Number.isFinite(n);
const string = (s, max) => typeof s === 'string' && s.length <= max;
export function formatLogTime(seconds) {
  if (!finite(seconds) || seconds < 0) return '—';
  const ms = Math.round(seconds * 1000), minutes = Math.floor(ms / 60000);
  return `${String(minutes).padStart(2, '0')}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}`;
}
export function parseLogTime(input) {
  const text = String(input).trim();
  assert(/^(?:\d+:){0,2}\d+(?:\.\d{1,6})?$/.test(text), '시각은 초 또는 분:초 / 시:분:초 형식으로 입력하세요.');
  const parts = text.split(':').map(Number);
  assert(parts.slice(1).every(n => n < 60), '시각의 분·초는 60 미만이어야 합니다.');
  const seconds = parts.reduce((n, p) => n * 60 + p, 0);
  assert(Number.isFinite(seconds), '시각을 확인하세요.');
  return seconds;
}
export function createSubstitutionLog(context, roster = []) {
  const counts = {home: 0, away: 0};
  const players = roster.filter(p => p.group !== 'referee').map(p => {
    const team = p.group.startsWith('home') ? 'home' : 'away';
    const index = p.group.endsWith('_gk') ? 0 : ++counts[team];
    return {id: p.id, team, name: p.name || `${team === 'home' ? '홈' : '원정'} ${p.group.endsWith('_gk') ? '키퍼' : `분석 #${p.jersey || index}`}`,
      jersey: p.externalId ? p.jersey : '', sourceSlotId: p.id};
  });
  return {schema: LOG_SCHEMA, video: {...context}, players, initialPlayers: players.map(p => p.id), substitutions: []};
}
export function validateSubstitutionLog(value, context) {
  assert([LOG_SCHEMA,'fpa-substitution-log/v1'].includes(value?.schema) && value.video, '교체 타임로그 JSON 형식이 올바르지 않습니다.');
  const {video, players, initialPlayers, substitutions} = value;
  assert(string(video.name, 1000) && video.name && [video.duration, video.from, video.to].every(finite) && video.from >= 0 && video.from < video.to && video.to <= video.duration + 1e-6, '타임로그의 영상 범위가 올바르지 않습니다.');
  if (context) assert(video.name === context.name && ['duration','from','to'].every(k => Math.abs(video[k] - context[k]) < 1e-6), '현재 영상·분석 구간과 다른 타임로그입니다.');
  assert(Array.isArray(players) && players.length <= 100, '선수는 최대 100명까지 등록할 수 있습니다.');
  const ids = new Set(), jerseys = new Set();
  for (const p of players) {
    assert(p && string(p.id, 160) && p.id && !ids.has(p.id) && ['home','away'].includes(p.team) && string(p.name, 80) && p.name.trim() && string(p.jersey, 3) && (!p.jersey || /^\d{1,3}$/.test(p.jersey)), '선수 식별명·등번호·팀을 확인하세요.');
    if (p.sourceSlotId !== undefined) assert(string(p.sourceSlotId, 160), '분석번호 연결 형식이 올바르지 않습니다.');
    const jerseyKey = `${p.team}:${Number(p.jersey)}`;
    assert(!p.jersey || !jerseys.has(jerseyKey), '같은 팀에 같은 등번호가 중복되었습니다.');
    if (p.jersey) jerseys.add(jerseyKey);
    ids.add(p.id);
  }
  assert(Array.isArray(initialPlayers) && initialPlayers.every(id => ids.has(id)) && new Set(initialPlayers).size === initialPlayers.length, '구간 시작 출전 명단을 확인하세요.');
  assert(Array.isArray(substitutions) && substitutions.length <= 10000, '교체 기록은 최대 10,000건까지 저장할 수 있습니다.');
  const eventIds = new Set(), active = new Set(initialPlayers), byId = new Map(players.map(p => [p.id, p]));
  let previous = null, participants = new Set();
  const uncertainTeams = new Set(), markerTimes = new Set();
  const sorted = [...substitutions].sort((a, b) => a?.time - b?.time);
  for (const e of sorted) {
    assert(e && string(e.id, 160) && e.id && !eventIds.has(e.id) && finite(e.time) && e.time >= video.from && e.time < video.to && ['home','away'].includes(e.team) && string(e.note, 500), '교체 시각·팀·메모를 확인하세요. 시각은 영상 구간 안이어야 합니다.');
    const paired=hasPlayerPair(e);
    assert(paired || (!e.outId && !e.inId && value.schema === LOG_SCHEMA), 'OUT·IN 연결은 두 선수 모두 지정하거나 비워두세요.');
    eventIds.add(e.id);
    if (!paired) {
      const key=`${e.team}:${e.time}`;
      assert(!markerTimes.has(key), '같은 팀·시각의 교체 로그가 이미 있습니다.');
      markerTimes.add(key);uncertainTeams.add(e.team);
      continue;
    }
    assert(byId.get(e.outId)?.team === e.team && byId.get(e.inId)?.team === e.team && e.outId !== e.inId, 'OUT·IN은 같은 팀의 서로 다른 선수여야 합니다.');
    if (previous !== e.time) participants = new Set();
    assert(!participants.has(e.outId) && !participants.has(e.inId), `${formatLogTime(e.time)}: 같은 선수를 동일 시각에 두 번 교체할 수 없습니다.`);
    assert(uncertainTeams.has(e.team) || active.has(e.outId), `${formatLogTime(e.time)}: OUT 선수가 출전 중이 아닙니다. 시작 명단과 앞선 교체 기록을 확인하세요.`);
    assert(uncertainTeams.has(e.team) || !active.has(e.inId), `${formatLogTime(e.time)}: IN 선수가 이미 출전 중입니다.`);
    active.delete(e.outId); active.add(e.inId);
    participants.add(e.outId); participants.add(e.inId); eventIds.add(e.id); previous = e.time;
  }
  return structuredClone({schema: value.schema, video, players, initialPlayers, substitutions: sorted});
}
export function saveSubstitution(log, event) {
  return validateSubstitutionLog({...log, substitutions: [...log.substitutions.filter(e => e.id !== event.id), event]}, log.video);
}
export function removeSubstitution(log, id) {
  return validateSubstitutionLog({...log, substitutions: log.substitutions.filter(e => e.id !== id)}, log.video);
}
export function activePlayersAt(log, time, before = false) {
  const active = new Set(log.initialPlayers);
  const unknown=new Set();
  for (const e of log.substitutions) if (e.time < time || (!before && e.time === time)) {
    if(!hasPlayerPair(e)) {unknown.add(e.team);for(const p of log.players.filter(p=>p.team===e.team))active.delete(p.id);}
    else if(!unknown.has(e.team)){active.delete(e.outId);active.add(e.inId);}
  }
  return active;
}
export function buildAppearanceIntervals(value) {
  const log = validateSubstitutionLog(value), starts = new Map(log.initialPlayers.map(id => [id, log.video.from]));
  const intervals = [], counts = new Map(), byId = new Map(log.players.map(p => [p.id, p]));
  function close(id, to) {
    const from = starts.get(id); starts.delete(id);
    if (to <= from) return;
    const stint = (counts.get(id) || 0) + 1; counts.set(id, stint);
    intervals.push({...byId.get(id), stint, from, to, videoSeconds: to - from});
  }
  const unknown=new Set();
  for (const e of log.substitutions) {
    if(!hasPlayerPair(e)) {
      unknown.add(e.team);
      for(const id of [...starts.keys()])if(byId.get(id)?.team===e.team)close(id,e.time);
    } else if(!unknown.has(e.team)){close(e.outId,e.time);starts.set(e.inId,e.time);}
  }
  for (const id of [...starts.keys()]) close(id, log.video.to);
  return intervals.sort((a, b) => a.from - b.from || a.team.localeCompare(b.team) || a.id.localeCompare(b.id));
}
export function exportSubstitutionLog(value) {
  const log = validateSubstitutionLog(value);
  return {...log, reviewWindows:buildSubstitutionWindows(log), unresolvedCount:log.substitutions.filter(e=>!hasPlayerPair(e)).length, clockBasis: 'source-video-seconds', intervalConvention: '[from,to)', trackingApplied: false,
    note: '교체 시각은 작업자가 기록하며 선수 신원은 별도 판정합니다. 미판정 시각 이후에는 해당 팀의 출전 구간을 확정하지 않습니다. 기존 트랙·히트맵에는 자동 반영되지 않습니다.',
    appearances: buildAppearanceIntervals(log)};
}
const csvCell = value => {
  let text = String(value ?? '');
  // Protect user-entered names/notes in spreadsheet programs.
  if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};
const csv = rows => '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
export function substitutionCsv(value) {
  const log = validateSubstitutionLog(value), players = new Map(log.players.map(p => [p.id, p]));
  return csv([['영상','교체ID','원본시각','원본초','팀','OUT_ID','OUT_식별명','OUT_등번호','IN_ID','IN_식별명','IN_등번호','메모'],
    ...log.substitutions.map(e => {const out = players.get(e.outId), incoming = players.get(e.inId); return [log.video.name,e.id,formatLogTime(e.time),e.time,e.team,out?.id||'',out?.name||'',out?.jersey||'',incoming?.id||'',incoming?.name||'',incoming?.jersey||'',e.note];})]);
}
export function appearancesCsv(log) {
  return csv([['영상','선수ID','팀','식별명','등번호','출전구간','시작시각','종료시각_미포함','시작_원본초','종료_원본초','영상기준_출전초'],
    ...buildAppearanceIntervals(log).map(p => [log.video.name,p.id,p.team,p.name,p.jersey,p.stint,formatLogTime(p.from),formatLogTime(p.to),p.from,p.to,p.videoSeconds])]);
}

// Source-video windows are candidate-search boundaries, never identity switches.
// Infer actual OUT/IN timestamps from boundary crossings before splitting tracks.
export function buildSubstitutionWindows(value, radius=15) {
  const log=validateSubstitutionLog(value);
  assert(finite(radius)&&radius>0&&radius<=60,'교체 탐색 범위를 확인하세요.');
  return log.substitutions.map(e=>({eventId:e.id,team:e.team,time:e.time,
    from:Math.max(log.video.from,e.time-radius),to:Math.min(log.video.to,e.time+radius),
    boundary:'camera-bottom',identityStatus:hasPlayerPair(e)?'linked':'pending',trackingApplied:false}));
}
