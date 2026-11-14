// History belongs to one selected frame. Saving keeps local undo history.
export class EditHistory {
 constructor(limit=80){this.limit=limit;this.past=[];this.future=[];}
 clear(){this.past=[];this.future=[];}
 push(snapshot){this.past.push(structuredClone(snapshot));if(this.past.length>this.limit)this.past.shift();this.future=[];}
 undo(current){if(!this.past.length)return null;this.future.push(structuredClone(current));return this.past.pop();}
 redo(current){if(!this.future.length)return null;this.past.push(structuredClone(current));return this.future.pop();}
 remap(assigned){for(const stack of [this.past,this.future])for(const snap of stack)for(const o of snap.objects||[])o.id=assigned[o.id]||o.id;}
}
export const objectEdit=o=>({id:o.id,role:o.role,pixelBox:o.pixelBox,footpointPixels:o.footpointPixels,footpointManual:o.footpointManual,footpointEvidence:o.footpointEvidence||'manual-proxy',footpointNote:o.footpointNote||'',excluded:o.excluded,spatialExcluded:!!o.spatialExcluded});
export function restoreObjects(snapshot,saved){
 const result=structuredClone(snapshot),ids=new Set(result.map(o=>o.id));
 // Undoing a saved addition is a reversible exclusion; never delete model output.
 for(const o of saved)if(!ids.has(o.id))result.push({...structuredClone(o),excluded:true});
 const baseline=new Map(saved.map(o=>[o.id,JSON.stringify(objectEdit(o))]));
 const changed=new Set(result.filter(o=>JSON.stringify(objectEdit(o))!==baseline.get(o.id)).map(o=>o.id));
 return {objects:result,dirty:changed};
}
