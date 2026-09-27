// Versioned, serial autosave: browser backup survives failed requests/reloads.
export class ServerReview {
  constructor(id,{request=fetch,storage=localStorage,status=()=>{}}={}){
    this.id=id;this.request=request;this.storage=storage;this.status=status;
    this.version=0;this.pending=null;this.running=null;this.conflict=false;
    this.key=`fpa-cv-cloud-draft:${id}`;
  }
  async open(){
    const response=await this.request(`/api/tracking/jobs/${this.id}/review`);
    if(!response.ok)throw Error('서버 검수를 불러오지 못했습니다. 새로고침 후 다시 열어 주세요.');
    const saved=await response.json();this.version=saved.version;
    let draft;try{draft=JSON.parse(this.storage.getItem(this.key));}catch{}
    this.initial=saved.review;
    if(draft?.pending){
      if(JSON.stringify(draft.review)===JSON.stringify(saved.review))this.storage.removeItem(this.key);
      else if(draft.version===saved.version){this.pending=draft.review;this.initial=draft.review;}
      else{this.conflict=true;this.initial=draft.review;this.status('서버에 다른 수정이 있습니다. 작업 백업 후 다시 열어 주세요.',true);}
    }
    return this.initial;
  }
  stage(review){
    this.pending=JSON.parse(JSON.stringify(review));
    try{this.storage.setItem(this.key,JSON.stringify({version:this.version,pending:true,review:this.pending}));}catch{}
    if(this.conflict){this.status('서버 저장 충돌 · 작업 백업이 필요합니다.',true);return;}
    this.status('서버 저장 대기');clearTimeout(this.timer);
    this.timer=setTimeout(()=>void this.flush().catch(()=>{}),500);
  }
  async flush(){
    clearTimeout(this.timer);
    if(this.running){await this.running;if(this.pending)return this.flush();return;}
    if(this.conflict)throw Error('서버 저장 충돌 · 작업 백업 후 다시 열어 주세요.');
    if(!this.pending)return;
    const snapshot=this.pending;this.pending=null;
    this.running=(async()=>{
      try{
        this.status('서버 저장 중');
        const response=await this.request(`/api/tracking/jobs/${this.id}/review`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:this.version,review:snapshot})});
        if(!response.ok){this.conflict=response.status===409;throw Error((await response.json()).detail||'서버 저장 실패');}
        this.version=(await response.json()).version;
        try{
          if(this.pending)this.storage.setItem(this.key,JSON.stringify({version:this.version,pending:true,review:this.pending}));
          else this.storage.removeItem(this.key);
        }catch{}
        this.status(this.pending?'서버 저장 대기':'서버 저장됨');
      }catch(error){this.pending=this.pending||snapshot;this.status(error.message+' · 브라우저 백업 유지',true);throw error;}
      finally{this.running=null;}
    })();
    await this.running;
    if(this.pending)return this.flush();
  }
  get dirty(){return !!(this.pending||this.running||this.conflict);}
}
