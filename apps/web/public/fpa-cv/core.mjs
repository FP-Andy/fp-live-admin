// Pure review logic shared by the local player and regression tests.
import { validRGB } from './colors.mjs';
import {validateLineup} from './lineup.mjs';
const finite = n => typeof n === 'number' && Number.isFinite(n);
const integer = n => Number.isSafeInteger(n) && n >= 0;
const assert = (value, message) => { if (!value) throw Error(message); };
export const clone = value => JSON.parse(JSON.stringify(value));
export const GROUPS = {
  home_gk: {label:'홈 키퍼',team:'home',count:1}, home: {label:'홈',team:'home',count:5},
  referee: {label:'심판',team:'referee',count:1}, away: {label:'원정',team:'away',count:5},
  away_gk: {label:'원정 키퍼',team:'away',count:1},
};
export function defaultRoster() {
  return Object.entries(GROUPS).flatMap(([group,info])=>Array.from({length:info.count},(_,i)=>({id:`${group}-${i+1}`,group,jersey:group==='referee'?'REF':''})));
}
export function personIdentity(review,personId) {
  const p=review.roster?.find(p=>p.id===personId);
  return p?{personId:p.id,group:p.group,team:GROUPS[p.group].team,jersey:p.jersey}:null;
}

export function validateDataset(data) {
  assert(data?.schema === 'fpa-tracks/v1' && typeof data.datasetId === 'string' && data.datasetId.length > 0, '지원하지 않는 트래킹 파일입니다.');
  const v = data.video;
  assert(v && typeof v.name === 'string' && [v.fps, v.width, v.height, v.duration, v.clipStart, v.clipEnd].every(finite), '영상 정보가 올바르지 않습니다.');
  assert(v.fps > 0 && v.width > 0 && v.height > 0 && v.clipStart >= 0 && v.clipEnd > v.clipStart && v.clipEnd <= v.duration + 0.01, '영상 시간 범위가 올바르지 않습니다.');
  assert(finite(data.detector?.sampleFps) && data.detector.sampleFps > 0, '샘플 FPS가 필요합니다.');
  assert(Array.isArray(data.frames) && data.frames.length > 0, '트래킹 프레임이 없습니다.');
  let previous = -1;
  const tracks = new Map();
  for (const frame of data.frames) {
    assert(finite(frame.t) && frame.t > previous && frame.t >= v.clipStart - 0.00001 && frame.t < v.clipEnd && Array.isArray(frame.boxes), '프레임 순서 또는 시간이 올바르지 않습니다.');
    previous = frame.t;
    const seen = new Set();
    for (const b of frame.boxes) {
      assert(integer(b.id) && !seen.has(b.id) && Array.isArray(b.box) && b.box.length === 4 && b.box.every(n => finite(n) && n >= 0 && n <= 1) && b.box[0] < b.box[2] && b.box[1] < b.box[3] && finite(b.confidence) && b.confidence >= 0 && b.confidence <= 1, '유효하지 않은 BB가 있습니다.');
      if(b.appearance!==undefined) assert(Array.isArray(b.appearance)&&b.appearance.length<=12&&b.appearance.every(p=>validRGB(p.rgb)&&finite(p.weight)&&p.weight>0&&p.weight<=1)&&b.appearance.reduce((sum,p)=>sum+p.weight,0)<=1.001,'유니폼 색상 정보가 올바르지 않습니다.');
      seen.add(b.id);
      if (!tracks.has(b.id)) tracks.set(b.id, { id: b.id, first: frame.t, last: frame.t, samples: 0 });
      const track = tracks.get(b.id); track.last = frame.t; track.samples++;
    }
  }
  return { ...data, tracks: [...tracks.values()] };
}

export function boxesAt(data, time) {
  if (!data || !finite(time) || time < data.video.clipStart || time >= data.video.clipEnd) return [];
  const frames = data.frames, tolerance = 1 / data.detector.sampleFps;
  let lo = 0, hi = frames.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (frames[mid].t <= time) lo = mid + 1; else hi = mid; }
  const left = frames[lo - 1], right = frames[lo];
  if (!left) return right && right.t - time <= tolerance / 2 ? right.boxes : [];
  if (!right) return time - left.t <= tolerance ? left.boxes : [];
  // Never interpolate across missing detections, different IDs, or large gaps.
  if (right.t - left.t > tolerance * 1.6) return time - left.t <= tolerance / 2 ? left.boxes : right.t - time <= tolerance / 2 ? right.boxes : [];
  const alpha = (time - left.t) / (right.t - left.t);
  // Introduce/remove IDs at their observed sample time, matching half-open
  // identity intervals. Otherwise a new box appears half a frame before its
  // inherited name, briefly flashing "unassigned" at a seamless handoff.
  const nearest = left;
  return nearest.boxes.map(b => {
    const a = left.boxes.find(item => item.id === b.id), z = right.boxes.find(item => item.id === b.id);
    return a && z ? { ...b, box: a.box.map((value, i) => value + (z.box[i] - value) * alpha) } : b;
  });
}

export function emptyReview(data) {
  return { schema: 'fpa-review/v1', datasetId: data.datasetId, segments: [], events: [], links: {}, offsets: {},
    roster:defaultRoster(),uniforms:Object.fromEntries(Object.keys(GROUPS).map(g=>[g,[]])),setup:null,autoReconnect:true,shadowCorrection:false,rejections:[],checkpoints:[],checkpointBudget:5 };
}
// Human checkpoints refer to one actual observation, never an interpolated BB
// or the entire lifetime of a raw tracker ID. Their end is derived on import.
export function checkpointFrame(data,time) {
  assert(finite(time)&&time>=data.video.clipStart&&time<data.video.clipEnd,'확인 장면이 영상 범위 밖입니다.');
  let lo=0,hi=data.frames.length;
  while(lo<hi){const m=(lo+hi)>>>1;if(data.frames[m].t<time)lo=m+1;else hi=m;}
  const choices=[lo-1,lo].filter(i=>i>=0&&i<data.frames.length);
  const index=choices.sort((a,b)=>Math.abs(data.frames[a].t-time)-Math.abs(data.frames[b].t-time))[0],frame=data.frames[index];
  assert(Math.abs(frame.t-time)<=1/data.detector.sampleFps+1e-6,'이 시점에 관측된 프레임이 없습니다.');
  return {frame,index,to:Math.min(data.video.clipEnd,frame.t+1/data.detector.sampleFps,data.frames[index+1]?.t??Infinity)};
}
export function saveCheckpoint(review,data,time,assignments) {
  const {frame,to}=checkpointFrame(data,time);
  assert(!review.setup||frame.t>review.setup.time+1/(data.detector.sampleFps*2),'초기 설정 이후의 장면을 선택하세요.');
  assert(Array.isArray(assignments)&&assignments.length>0&&assignments.length<=13,'한 명 이상 확인하세요.');
  assert(assignments.every(a=>integer(a.trackId)&&frame.boxes.some(b=>b.id===a.trackId)&&review.roster.some(p=>p.id===a.personId&&p.jersey)),'이 장면의 BB와 명단 선수를 연결하세요.');
  assert(new Set(assignments.map(a=>a.trackId)).size===assignments.length&&new Set(assignments.map(a=>a.personId)).size===assignments.length,'한 장면에서 한 선수는 하나의 BB에만 지정할 수 있습니다.');
  const checkpoint={time:frame.t,to,assignments:assignments.map(({trackId,personId})=>({trackId,personId})).sort((a,b)=>a.personId.localeCompare(b.personId))};
  return {...review,checkpoints:[...(review.checkpoints||[]).filter(c=>Math.abs(c.time-frame.t)>1e-6),checkpoint].sort((a,b)=>a.time-b.time)};
}
export function checkpointSegments(review) {
  return (review.checkpoints||[]).flatMap(c=>c.assignments.map(a=>({...personIdentity(review,a.personId),trackId:a.trackId,from:c.time,to:c.to,source:'manual',locked:true,checkpoint:true})));
}
export function identityAt(review, id, time) {
  const segment=review.segments.find(s => s.trackId === id && s.from <= time && time < s.to);
  return segment?{...segment,...(personIdentity(review,segment.personId)||{})}:null;
}
export function trackRange(data, id) {
  const t = data.tracks.find(track => track.id === id);
  assert(t, '존재하지 않는 트랙입니다.');
  return [Math.max(data.video.clipStart, t.first), Math.min(data.video.clipEnd, t.last + 1 / data.detector.sampleFps)];
}
export function assign(review, data, id, from, to, identity) {
  const [min, max] = trackRange(data, id);
  assert(finite(from) && finite(to) && from >= min - 0.00001 && to <= max + 0.00001 && from < to, '적용 구간이 트랙 범위를 벗어납니다.');
  if (identity) {
    if(identity.personId) {const p=personIdentity(review,identity.personId);assert(p,'명단에 없는 선수입니다.');identity={...identity,...p};}
    assert(['home', 'away', 'referee', 'ignore'].includes(identity.team), '팀을 선택하세요.');
    assert(identity.team === 'ignore' || (identity.team==='referee'?/^[\w가-힣-]{1,12}$/.test(identity.jersey):/^\d{1,3}$/.test(identity.jersey)), '등번호는 0–999, 심판 표기는 1–12자로 입력하세요.');
  }
  const segments = [];
  for (const s of review.segments) {
    if (s.trackId !== id || s.to <= from || s.from >= to) { segments.push(s); continue; }
    if (s.from < from) segments.push({ ...s, to: from });
    if (s.to > to) segments.push({ ...s, from: to });
  }
  if (identity) segments.push({ trackId: id, from, to, team: identity.team, jersey: identity.team === 'ignore' ? '' : identity.jersey,
    ...(identity.personId?{personId:identity.personId,group:identity.group}:{}),...(identity.source?{source:identity.source}:{}),...(identity.locked===true?{locked:true}:{}) });
  segments.sort((a, b) => a.trackId - b.trackId || a.from - b.from);
  return { ...review, segments };
}
export function parseTime(value) {
  if (finite(value)) return value >= 0 ? value : null;
  if (typeof value !== 'string' || !/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(value.trim())) return null;
  const parts = value.trim().split(':').map(Number);
  if (parts.slice(1).some(n => n >= 60)) return null;
  return parts.reduce((a, n) => a * 60 + n, 0);
}
export function importEvents(payload) {
  assert(Array.isArray(payload?.rows) && payload.rows.length && payload.rows.every(row => row && typeof row === 'object' && !Array.isArray(row)), 'FPA rows 배열이 포함된 JSON을 선택하세요.');
  assert(payload.logs === undefined || (Array.isArray(payload.logs) && payload.logs.every(log => typeof log === 'string')), 'logs 형식이 올바르지 않습니다.');
  return payload.rows.map((row, index) => ({ index, row: clone(row), log: payload.logs?.[index] || '', half: String(row.Half || payload.logs?.[index]?.split(' | ')[0] || '1H'), seconds: parseTime(row.Time) }));
}
export function validateReview(value, data) {
  assert(value?.schema === 'fpa-review/v1' && value.datasetId === data.datasetId, '이 트래킹 실행과 다른 검수 파일입니다. 원래 tracks.json을 먼저 열어 주세요.');
  assert(Array.isArray(value.segments) && Array.isArray(value.events) && value.links && typeof value.links === 'object' && value.offsets && typeof value.offsets === 'object', '검수 파일 형식이 올바르지 않습니다.');
  let result = emptyReview(data);
  if(value.roster!==undefined) {
    const expected=defaultRoster();
    assert(Array.isArray(value.roster)&&value.roster.length===13&&expected.every(p=>value.roster.filter(r=>r.id===p.id&&r.group===p.group).length===1),'명단은 홈 키퍼 1·홈 5·심판 1·원정 5·원정 키퍼 1명이어야 합니다.');
    assert(value.roster.every(p=>typeof p.jersey==='string'&&(p.jersey===''||(p.group==='referee'?/^[\w가-힣-]{1,12}$/.test(p.jersey):/^\d{1,3}$/.test(p.jersey)))),'명단의 등번호가 올바르지 않습니다.');
    result.roster=clone(value.roster);
  }
  if(value.uniforms!==undefined) {
    assert(Object.keys(GROUPS).every(g=>Array.isArray(value.uniforms[g])&&value.uniforms[g].length<=8&&value.uniforms[g].every(validRGB)),'유니폼 색상은 그룹마다 최대 8개 RGB 샘플이어야 합니다.');
    result.uniforms=Object.fromEntries(Object.keys(GROUPS).map(g=>[g,clone(value.uniforms[g])]));
  }
  if(value.setup) {
    assert(finite(value.setup.time)&&value.setup.time>=data.video.clipStart&&value.setup.time<data.video.clipEnd,'초기 설정 시점이 범위 밖입니다.');
    result.setup={time:value.setup.time};
  }
  result.autoReconnect=value.autoReconnect!==false;
  if(value.shadowCorrection!==undefined)assert(typeof value.shadowCorrection==='boolean','몸·그림자 정리 설정이 올바르지 않습니다.');
  result.shadowCorrection=value.shadowCorrection===true;
  if(value.checkpointBudget!==undefined){assert([5,10,15].includes(value.checkpointBudget),'확인 장면 예산은 5·10·15 중 선택하세요.');result.checkpointBudget=value.checkpointBudget;}
  if(value.checkpoints!==undefined){
    assert(Array.isArray(value.checkpoints)&&value.checkpoints.length<=1000,'확인 장면 형식이 올바르지 않습니다.');
    for(const c of value.checkpoints){assert(c&&finite(c.time),'확인 장면 시각이 올바르지 않습니다.');result=saveCheckpoint(result,data,c.time,c.assignments);}
    assert(result.checkpoints.length===value.checkpoints.length,'같은 확인 장면이 중복되어 있습니다.');
  }
  if(value.rejections!==undefined) {
    assert(Array.isArray(value.rejections)&&value.rejections.every(r=>integer(r.trackId)&&result.roster.some(p=>p.id===r.personId)&&finite(r.from)&&finite(r.to)&&r.from<r.to),'거절한 재연결 정보가 올바르지 않습니다.');
    result.rejections=clone(value.rejections);
  }
  for (const s of value.segments) {
    assert(!result.segments.some(t => t.trackId === s.trackId && t.from < s.to && s.from < t.to), '중복된 할당 구간입니다.');
    result = assign(result, data, s.trackId, s.from, s.to, s);
  }
  const events = value.events.length ? importEvents({ rows: value.events.map(e => e.row), logs: value.events.map(e => e.log) }) : [];
  for (const offset of Object.values(value.offsets)) assert(finite(offset), '영상 오프셋이 올바르지 않습니다.');
  for (const [index, links] of Object.entries(value.links)) {
    assert(/^\d+$/.test(index) && events[Number(index)] && links && typeof links === 'object', '이벤트 연결이 올바르지 않습니다.');
    for (const [role, link] of Object.entries(links)) {
      assert(['actor', 'receiver'].includes(role) && integer(link?.trackId) && finite(link?.time) && boxesAt(data, link.time).some(b => b.id === link.trackId), '검출 구간 밖의 이벤트 연결입니다.');
    }
  }
  if(value.fpa!==undefined) {
    assert(value.fpa&&typeof value.fpa==='object'&&!Array.isArray(value.fpa),'FPA 작업 정보가 올바르지 않습니다.');
    result.fpa=clone(value.fpa);
  }
  if(value.lineup!==undefined)result.lineup=validateLineup(value.lineup);
  if(value.workflow!==undefined){assert(typeof value.workflow?.reviewing==='boolean','검수 단계 형식이 올바르지 않습니다.');result.workflow={reviewing:value.workflow.reviewing};}
  if(value.batch!==undefined){
    const b=value.batch;
    assert(b&&Number.isSafeInteger(b.round)&&b.round>=0&&b.applied&&typeof b.applied==='object','검수 반영 이력이 올바르지 않습니다.');
    assert(b.completedAt===null||typeof b.completedAt==='string'&&Number.isFinite(Date.parse(b.completedAt)),'검수 반영 시각이 올바르지 않습니다.');
    const {segments,roster,uniforms,setup,autoReconnect,rejections,checkpoints,shadowCorrection}=b.applied;
    const valid=validateReview({...emptyReview(data),segments,roster,uniforms,setup,autoReconnect,rejections,checkpoints,shadowCorrection},data);
    const history=b.history||[];
    assert(Array.isArray(history)&&history.length<=100&&history.every(h=>integer(h.version)&&h.version>0&&h.version<=b.round+1&&typeof h.completedAt==='string'&&Number.isFinite(Date.parse(h.completedAt))&&integer(h.checkpoints)&&integer(h.manualIntervals)&&Array.isArray(h.changes)&&h.changes.every(c=>typeof c==='string'&&c.length<50))&&new Set(history.map(h=>h.version)).size===history.length,'검수 회차 이력이 올바르지 않습니다.');
    result.batch={round:b.round,completedAt:b.completedAt,history:clone(history),applied:Object.fromEntries(['segments','roster','uniforms','setup','autoReconnect','rejections','checkpoints','shadowCorrection'].map(k=>[k,valid[k]]))};
  }
  return { ...result, events, offsets: clone(value.offsets), links: clone(value.links) };
}
export function eventPatches(review) {
  return review.events.map(event => {
    const patch = { rowIndex: event.index, original: clone(event.row), originalLog: event.log, actor: null, receiver: null };
    for (const role of ['actor', 'receiver']) {
      const link = review.links[event.index]?.[role];
      if (!link) continue;
      const duplicate=review.duplicateAliases?.find(d=>d.trackId===link.trackId&&d.from<=link.time&&link.time<d.to);
      const identity = identityAt(review, duplicate?.canonicalTrackId??link.trackId, link.time);
      patch[role] = { ...link, team: identity?.team || null, jersey: identity?.jersey || null,
        ...(duplicate?{canonicalTrackId:duplicate.canonicalTrackId}:{}),
        ...(identity?.personId?{personId:identity.personId,group:identity.group}:{}),
        status: identity?.team==='referee'?'not_player':identity && identity.team !== 'ignore' ? identity.source==='auto'||duplicate?'suggested':'reviewed' : 'unresolved' };
    }
    return patch;
  });
}
export function label(identity, id) {
  return !identity ? `#${id} · 미확정` : identity.team === 'ignore' ? `#${id} · 제외` : identity.team==='referee'?`심판 ${identity.jersey}`:`${identity.group?.endsWith('_gk')?(identity.team==='home'?'홈 GK':'원정 GK'):identity.team==='home'?'홈':'원정'} No.${identity.jersey}`;
}
export function clock(seconds) {
  if (!finite(seconds)) return '—';
  const s = Math.max(0, seconds);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}`;
}
