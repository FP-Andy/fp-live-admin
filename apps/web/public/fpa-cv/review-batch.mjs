import {recoveryInputs,recoverySignature,emptyRecovery} from './recovery-protocol.mjs';
import {effectiveSegments} from './integrity.mjs';

export function previewSegments(review,recovery,applied){
  if(!applied||recoverySignature(review)===recoverySignature(applied))return effectiveSegments(review,recovery);
  const before=new Set(applied.segments.map(s=>JSON.stringify(s))),after=new Set(review.segments.map(s=>JSON.stringify(s)));
  const added=review.segments.filter(s=>!before.has(JSON.stringify(s)));
  const removed=applied.segments.filter(s=>!after.has(JSON.stringify(s)));
  const cuts=[...removed.map(s=>({...s,personId:null})),...added,...review.rejections.map(s=>({...s,rejection:true}))];
  let automatic=recovery.segments;
  for(const cut of cuts)automatic=automatic.flatMap(s=>{
    const match=cut.rejection?s.trackId===cut.trackId&&s.personId===cut.personId:s.trackId===cut.trackId||(cut.personId&&s.personId===cut.personId);
    return !match||s.to<=cut.from||s.from>=cut.to?[s]:[...(s.from<cut.from?[{...s,to:cut.from}]:[]),...(s.to>cut.to?[{...s,from:cut.to}]:[])];
  });
  // A fresh human correction wins over masks from the previously applied run.
  const masks=recovery.masks.filter(m=>!added.some(s=>s.trackId===m.trackId&&s.personId===m.personId&&s.from<m.to&&s.to>m.from));
  return effectiveSegments(review,{...recovery,segments:automatic,masks});
}

// Only initialize/run may call the solver. Editing, undo and FPA input merely
// change getReview(). A running job owns an immutable snapshot of its inputs.
export class ReviewBatch {
  constructor({data,getReview,saveState,compute,hydrate,onChange=()=>{},cancel=()=>{}}){
    Object.assign(this,{data,getReview,saveState,compute,hydrate,onChange,cancelWorker:cancel});
    const saved=getReview().batch;
    this.applied=structuredClone(saved?.applied||recoveryInputs(getReview()));
    this.round=saved?.round||0;this.completedAt=saved?.completedAt||null;
    this.history=structuredClone(saved?.history||[]);
    this.result=null;this.running=false;this.error=null;this.ticket=0;
  }
  get dirty(){return recoverySignature(this.getReview())!==recoverySignature(this.applied);}
  get view(){return {...(this.result||emptyRecovery(this.data)),status:this.running?'pending':this.error?'error':!this.result?'cancelled':this.dirty?'staged':'complete',hasResult:!!this.result};}
  get changes(){
    const current=recoveryInputs(this.getReview()),names={segments:'번호·구간',roster:'명단',uniforms:'유니폼',setup:'초기 설정',autoReconnect:'연결 설정',rejections:'연결 거절',checkpoints:'확인 장면'};
    return Object.keys(names).filter(k=>JSON.stringify(current[k])!==JSON.stringify(this.applied[k])).map(k=>names[k]);
  }
  state(){return {applied:structuredClone(this.applied),round:this.round,completedAt:this.completedAt,history:structuredClone(this.history)};}
  async run({restore=false}={}){
    if(this.running)return false;
    const snapshot=structuredClone(restore?this.applied:recoveryInputs(this.getReview())),ticket=++this.ticket,changes=this.changes;
    // Persist the previous applied inputs even before the first result finishes,
    // so reloading cannot implicitly submit subsequently edited draft labels.
    this.saveState(this.state());this.running=true;this.error=null;this.onChange();
    try{
      const response=await this.compute(snapshot);
      if(ticket!==this.ticket)return false;
      this.result=this.hydrate(response.result,this.data);this.applied=snapshot;
      if(!restore)this.round++;
      this.completedAt=restore&&this.completedAt?this.completedAt:new Date().toISOString();
      if(!this.history.some(h=>h.version===this.round+1))this.history.push({version:this.round+1,completedAt:this.completedAt,checkpoints:snapshot.checkpoints?.length||0,manualIntervals:snapshot.segments.length,changes:restore?[]:changes});
      this.history=this.history.slice(-100);
      this.running=false;this.saveState(this.state());this.onChange();return true;
    }catch(error){
      if(ticket!==this.ticket)return false;
      this.running=false;this.error=error.message||String(error);this.onChange();return false;
    }
  }
  cancel(){++this.ticket;this.cancelWorker();this.running=false;this.error='연결 계산을 중지했습니다.';this.onChange();}
}
