'use client';
import {useEffect,useRef,useState} from 'react';
import {apiJson} from '../../lib/api';
import type {ReportDraft} from '../../lib/futsal-report';
import type {SubstitutionReport} from '../../public/fpa-cv/substitution-report.mjs';
import type {SubstitutionLog,Substitution} from '../../public/fla-video/substitution-log.mjs';
export type SavedLog={revision:number;log:SubstitutionLog|null};
export function useSubstitutionReport(draft:ReportDraft|null,apply:(r:SubstitutionReport)=>Promise<void>){
 const current=useRef(draft),applyRef=useRef(apply);current.current=draft;applyRef.current=apply;
 const [state,setState]=useState<'checking'|'working'|'ready'|'review'|'error'|'none'>('checking'),[error,setError]=useState(''),[saved,setSaved]=useState<SavedLog|null>(null),[canWrite,setCanWrite]=useState(false),[progress,setProgress]=useState('');
 const refreshRef=useRef<()=>Promise<void>>(async()=>{}),client=useRef(''),worker=useRef<Worker|null>(null),requested=useRef('');
 useEffect(()=>{const d=current.current;if(!d?.matchId||!d.sourceSnapshot){setState('none');setSaved(null);return;}
  let active=true,busy=false,ticket=0;requested.current='';setState('checking');setError('');
  const w=new Worker('/fpa-cv/substitution-report-worker.mjs',{type:'module'});worker.current=w;
  w.onmessage=({data})=>{if(!active||data.ticket!==ticket)return;if(data.error){setError(data.error);setState('error');requested.current='';return;}if(data.progress){setProgress(data.progress.phase);return;}if(data.result){void applyRef.current(data.result).then(()=>{if(active&&data.ticket===ticket){setState(data.result.status);setProgress('');}}).catch(e=>{if(active){setError(e.message);setState('error');requested.current='';}});}};
  w.onerror=()=>{if(active){setError('교체 분석을 실행하지 못했습니다. 다시 시도하세요.');setState('error');requested.current='';}};
  const refresh=async()=>{if(busy||!active)return;busy=true;try{const v=await apiJson<{substitutions:SavedLog;can_write_substitutions?:boolean}>(`/futsal/fla-video/matches/${d.matchId}`);if(!active)return;setSaved(v.substitutions);setCanWrite(!!v.can_write_substitutions);const key=d.sourceSnapshot!.id+':'+v.substitutions.revision;
   if(requested.current!==key){requested.current=key;setState('working');setError('');setProgress('추적 원본·교체로그 불러오는 중');w.postMessage({ticket:++ticket,snapshotId:d.sourceSnapshot!.id,jobId:d.sourceSnapshot!.jobId,saved:v.substitutions});}
  }catch(e){if(active){setError(e instanceof Error?e.message:String(e));setState('error');}}finally{busy=false;}};
  refreshRef.current=refresh;const channel=typeof BroadcastChannel!=='undefined'?new BroadcastChannel('fpc-substitutions'):null;const onChange=()=>{void refresh();};if(channel)channel.onmessage=onChange;
  window.addEventListener('focus',onChange);window.addEventListener('storage',onChange);const timer=setInterval(onChange,15000);void refresh();
  return()=>{active=false;ticket++;clearInterval(timer);channel?.close();w.terminate();worker.current=null;window.removeEventListener('focus',onChange);window.removeEventListener('storage',onChange);};
 },[draft?.id,draft?.matchId,draft?.sourceSnapshot?.id]);
 async function confirm(eventId:string,tracking:Substitution['tracking']){
  const d=current.current;if(!d||!saved?.log||!canWrite)throw Error('교체로그 수정 권한을 확인하세요.');
  client.current ||=crypto.randomUUID();setState('working');setError('');
  try{await apiJson(`/futsal/fla-video/matches/${d.matchId}/substitutions`,{method:'PUT',body:JSON.stringify({client_id:client.current,request_id:crypto.randomUUID(),revision:saved.revision,log:{...saved.log,substitutions:saved.log.substitutions.map(e=>e.id===eventId?{...e,tracking}:e)}})});await refreshRef.current();}
  catch(e){setError(e instanceof Error?e.message:String(e));setState('error');throw e;}
 }
 async function assertFresh(expected=current.current){const d=expected;if(!d?.sourceSnapshot)return;
  if(state!=='ready'||!d.substitutionReport)throw Error('교체 연결 확인과 갱신을 완료한 뒤 추출하세요.');
  const [v,snapshots]=await Promise.all([apiJson<{substitutions:SavedLog}>(`/futsal/fla-video/matches/${d.matchId}`),apiJson<{snapshots:Array<{id:string;version:number}>}>(`/futsal/analysis-snapshots?job_id=${d.sourceSnapshot.jobId}`)]);
  if(v.substitutions.revision!==d.substitutionReport.provenance.logRevision){void refreshRef.current();throw Error('교체로그가 변경되었습니다. 최신 결과로 갱신 후 다시 추출하세요.');}
  if(snapshots.snapshots.some(s=>s.version>d.sourceSnapshot!.version))throw Error('새 분석 스냅샷이 있습니다. 최신 결과를 불러온 뒤 추출하세요.');
 }
 return {state,error,saved,canWrite,progress,refresh:()=>{requested.current='';return refreshRef.current();},confirm,assertFresh,blocked:!!draft?.sourceSnapshot&&state!=='ready'};
}
