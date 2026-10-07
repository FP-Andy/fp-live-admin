export type BasketballDraft={events:any[];lineups:any;timer:any};
type Packet=Partial<BasketballDraft>&{revision:number;request_id:string};
type Journal={base:BasketballDraft;value:BasketballDraft;revision:number;packet:Packet|null};
type StorageLike=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
const memory=new Map<string,Journal>();
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
/** Retain the original packet until acknowledged. Timer-only packets stay small. */
export function createBasketballPersistence(key:string,initial:BasketballDraft,initialRevision:number,send:(p:Packet)=>Promise<{revision:number;current_revision?:number}>,storage:()=>StorageLike,delay=350){
 let base=initial,value=initial,revision=initialRevision,packet:Packet|null=null,error='',journalFailed=false,running:Promise<void>|null=null,timer:ReturnType<typeof setTimeout>|undefined;
 const listeners=new Set<()=>void>();const emit=()=>listeners.forEach(fn=>fn());
 try{const saved=memory.get(key)||JSON.parse(storage().getItem(key)||'null') as Journal|null;if(saved&&Array.isArray(saved.value?.events)&&Array.isArray(saved.base?.events)&&Number.isInteger(saved.revision)){({base,value,revision,packet}=saved);error='미확인 입력을 복구했습니다. 같은 요청을 다시 확인하세요.';}}catch{journalFailed=true;}
 const dirty=()=>!!packet||!same(base,value);
 const journal=()=>{if(dirty())memory.set(key,{base,value,revision,packet});else memory.delete(key);try{if(dirty())storage().setItem(key,JSON.stringify({base,value,revision,packet}));else storage().removeItem(key);journalFailed=false;}catch{journalFailed=true;}};
 async function flush():Promise<void>{
  clearTimeout(timer);if(running)return running;
  const run=(async()=>{while(dirty()){
   if(!packet){const changes:Partial<BasketballDraft>={};for(const k of ['events','lineups','timer'] as const)if(!same(base[k],value[k]))changes[k]=value[k];packet={...changes,revision,request_id:crypto.randomUUID()};}
   journal();emit();
   try{const result=await send(packet);if((result.current_revision??result.revision)>result.revision)throw Error('이 요청 이후 다른 창의 변경이 있습니다. 복구 JSON과 서버 기록을 비교하세요.');
    const {request_id:_,revision:__,...changes}=packet;base={...base,...changes};revision=result.revision;packet=null;error='';journal();emit();
   }catch(e){error=e instanceof Error?e.message:'서버 저장 실패';journal();emit();throw e;}
  }})();running=run;
  try{await run;}finally{if(running===run)running=null;if(!dirty())clearTimeout(timer);emit();}
 }
 return {stage(next:BasketballDraft){value=next;journal();clearTimeout(timer);if(!error)timer=setTimeout(()=>void flush().catch(()=>{}),delay);emit();},flush,
  state:()=>({value,revision,dirty:dirty(),error,journalFailed,saving:!!running}),
  subscribe(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn);};},
  dispose(){clearTimeout(timer);journal();},
  server(remote:BasketballDraft,nextRevision:number){if(running)throw Error('저장 확인 후 다시 시도하세요.');base=value=remote;revision=nextRevision;packet=null;error='';journal();emit();}
 };
}
