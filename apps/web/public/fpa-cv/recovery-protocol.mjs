// Bump when identity/colour/continuity rules or this compact format change.
export const RECOVERY_VERSION = 'identity-v4-team-review-2';

export function recoveryInputs(review) {
  const {segments, roster, uniforms, setup, autoReconnect, rejections,checkpoints} = review;
  return {segments, roster, uniforms, setup, autoReconnect, rejections,checkpoints};
}
export const recoverySignature = review => JSON.stringify(recoveryInputs(review));

export function emptyRecovery(data, status = 'pending') {
  return {data, status, segments:[], suggestions:[], warnings:[], lockedConflicts:[], issues:[], waiting:[], masks:[], duplicates:[], timeline:new Map(), hasAppearance:false};
}

// Consolidation only removes duplicate observations. Keep the original dataset
// on each side of the worker, and transfer/cache just the removed IDs and labels.
export function packRecovery(result, original) {
  const {data, ...labels} = result;
  const hidden = [];
  for (let i=0; i<original.frames.length; i++) {
    const before=original.frames[i].boxes, after=data.frames[i].boxes;
    if (before.length === after.length) continue;
    const keep=new Set(after.map(b=>b.id));
    hidden.push([i,before.filter(b=>!keep.has(b.id)).map(b=>b.id)]);
  }
  return {...labels,hidden};
}

export function hydrateRecovery(packed, data) {
  const {hidden, ...labels} = packed;
  const frames = data.frames.slice();
  for (const [index, ids] of hidden) {
    const removed=new Set(ids), frame=frames[index];
    frames[index]={...frame,boxes:frame.boxes.filter(b=>!removed.has(b.id))};
  }
  return {...labels,data:{...data,frames,keeperContext:labels.keeperContext},status:'complete'};
}

export async function digest(value) {
  const bytes=typeof value==='string'?new TextEncoder().encode(value):value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export async function recoveryCacheKey(contentHash, review) {
  return `${RECOVERY_VERSION}:${contentHash}:${await digest(recoverySignature(review))}`;
}
