import {courtDistance, nearest, intersection} from './substitution-refinement.mjs';

export const IDENTITY_GUARD_VERSION = 'substitution-identity-guard/v1';
const sum = rows => rows.reduce((n, q) => n + q.seconds, 0);
const reviewed = q => q.identitySource === 'assistant-video-review';
const impossible = (a, b, distance) => {
  const dt = b.t - a.t, metres = distance([a.x, a.y], [b.x, b.y]);
  return dt >= 0 && dt <= 1 && metres > 2 && metres > dt * 12;
};

/** Audit existing allocations as well as newly recovered detections. A raw ID
 * present on a different body cannot be a reset of the entrant's current ID.
 * Quarantine the whole conflicting fragment and its unconnected descendants,
 * not just the single coordinate where the report happens to jump.
 * This is a conservative guard, not proof that every retained identity is right.
 * The original snapshot/operator annotations are never changed here. */
export function guardSubstitutionIdentities(snapshot, evidence, result) {
  const distance = courtDistance(snapshot), step = evidence.step || .1;
  const raw = new Map(), byTrack = new Map();
  for (const path of evidence.paths.values()) for (const o of path.list) {
    const rows = raw.get(o.b.id) || new Map(); rows.set(o.t, o); raw.set(o.b.id, rows);
  }
  for (const [id, observations] of raw) {
    let segment;
    for (const o of [...observations.values()].sort((a, b) => a.t - b.t)) {
      const previous = segment?.list.at(-1);
      if (!previous || o.t - previous.t > Math.max(.75, step * 3) ||
          impossible({t:previous.t,x:previous.xy[0],y:previous.xy[1]}, {t:o.t,x:o.xy[0],y:o.xy[1]}, distance)) {
        segment = {id:`${id}@${o.t.toFixed(6)}`, trackId:id, list:[]};
        const list = byTrack.get(id) || []; list.push(segment); byTrack.set(id, list);
      }
      segment.list.push(o);
    }
  }
  const at = (id, t) => (byTrack.get(id) || []).find(s => s.list[0].t - step * .6 <= t && s.list.at(-1).t + step * .6 >= t);
  const apartCache = new Map();
  const seenApart = (a, b) => {
    if (!a || !b || a.id === b.id) return null;
    const key = [a.id,b.id].sort().join('|');
    if (apartCache.has(key)) return apartCache.get(key);
    let proof = null, count = 0;
    // Two separate samples avoid treating one noisy box as a separate person.
    for (const q of a.list.length < b.list.length ? a.list : b.list) {
      const rows = a.list.length < b.list.length ? b.list : a.list;
      const r = nearest(rows, q.t);
      if (!r || Math.abs(q.t-r.t) > step * .55) continue;
      const aa=q.b.box, bb=r.b.box;
      if (intersection(aa,bb) === 0 && distance(q.xy,r.xy) > 2) {
        proof = {time:q.t,trackIds:[q.b.id,r.b.id],boxes:[aa,bb]};
        if (++count >= 2) break;
      }
    }
    const answer = count >= 2 ? proof : null; apartCache.set(key, answer); return answer;
  };
  const changed = new Set(), audit = [];
  for (const p of result.heatmap.players) {
    if (p.substitutionStint?.kind !== 'substitute' || !p.positions.length) continue;
    // Direct video review stores a time-scoped allocation. A raw ID can have
    // belonged to a different body before that accepted interval; comparing
    // its whole historical fragment would undo the reviewed ID-switch repair.
    if (p.substitutionStint.visualReviewId) continue;
    const positions = [...p.positions].sort((a,b)=>a.t-b.t), before = sum(positions);
    const seed = at(p.substitutionStint.entryTrackId,p.activeFrom);
    const seedObservation = seed && nearest(seed.list,p.activeFrom);
    let anchor = seed, last = seedObservation?.heatXY ? {t:seedObservation.t,x:seedObservation.heatXY[0],y:seedObservation.heatXY[1]} : null;
    let quarantine = false;
    const rejected = new Map(), kept = [], removed = [], conflicts = [];
    for (const q of positions) {
      const segment = at(q.trackId,q.t), key = segment?.id;
      const proof = seenApart(anchor,segment);
      let reason = key && rejected.get(key);
      if (!reason && proof) reason = 'simultaneous-distinct-bodies';
      if (!reason && last && impossible(last,q,distance)) reason = 'impossible-transition';
      // A video-reviewed anchor can restart an uncertain chain, but cannot
      // override simultaneous-body or impossible-motion evidence silently.
      if (!reason && quarantine && segment?.id !== anchor?.id && !reviewed(q)) {
        const dt = last ? q.t-last.t : Infinity;
        if (!segment || !last || dt > 3.5 || distance([last.x,last.y],[q.x,q.y]) > 1+Math.max(0,dt)*7)
          reason = 'unconnected-after-conflict';
      }
      if (reason) {
        if (key && !rejected.has(key)) {
          rejected.set(key,reason); conflicts.push({reason,time:q.t,trackId:q.trackId,anchorTrackId:anchor?.trackId,proof});
        }
        removed.push(q); quarantine = true; continue;
      }
      kept.push(q); last = q; anchor = segment;
      if (reviewed(q)) quarantine = false;
    }
    if (!removed.length) continue;
    // Identity gaps must not be filled back in by heatmap augmentation.
    const blocks=[], rejectedRows=new Set(removed);let block=null;
    for (const q of positions) {
      if(rejectedRows.has(q)) {
        block??={from:q.t,to:q.t+q.seconds,reason:'identity-conflict'};
        block.to=q.t+q.seconds;
      }else if(block){block.to=q.t;blocks.push(block);block=null;}
    }
    if(block){block.to=Math.max(block.to,p.activeTo??result.heatmap.to);blocks.push(block);}
    p.positions=kept; p.observed=sum(kept); p.coverage=p.observed/(result.heatmap.to-result.heatmap.from);
    p.blockedIntervals=[...(p.blockedIntervals||[]),...blocks];
    p.grid=Array(result.heatmap.width*result.heatmap.height).fill(0);
    for (const q of kept) p.grid[Math.min(result.heatmap.height-1,Math.floor(q.y*result.heatmap.height))*result.heatmap.width+Math.min(result.heatmap.width-1,Math.floor(q.x*result.heatmap.width))]+=q.seconds;
    // The caller rebuilds augmentation using only the retained coordinates.
    delete p.augmentation; delete p.renderScale;
    changed.add(p.id);
    const row={personId:p.id,team:p.group,number:p.jersey,before,after:p.observed,removedSeconds:sum(removed),manualConflictSeconds:sum(removed.filter(q=>q.source==='manual'||q.checkpoint||reviewed(q))),conflicts,quarantinedIntervals:blocks};
    audit.push(row);
    const event=result.events.find(e=>e.inPersonId===p.id);
    if(event){event.trackingStatus='partial';event.trackingWarning='서로 다른 객체가 섞인 연결 후보를 제외했습니다. 남은 연결 구간의 검수가 필요합니다.';}
    result.status='review'; result.heatmap.substitutionsApplied=false;
  }
  // Re-running a reviewed derivative must not erase its quarantine history.
  const old=result.identityGuard?.algorithm===IDENTITY_GUARD_VERSION?result.identityGuard.audit:[];
  result.identityGuard={algorithm:IDENTITY_GUARD_VERSION,audit:[...old.filter(r=>!changed.has(r.personId)),...audit]};
  return {result,changed};
}
