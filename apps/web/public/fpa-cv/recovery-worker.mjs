import {validateDataset} from './core.mjs';
import {reconnect} from './identity.mjs';
import {digest,packRecovery,hydrateRecovery,recoveryCacheKey} from './recovery-protocol.mjs';
import {recoveryCache} from './recovery-cache.mjs';
import {CHECKPOINT_PLAN_VERSION,planCheckpoints} from './checkpoint-plan.mjs';
import {effectiveSegments} from './integrity.mjs';

let data=null, contentHash=null,baselineMemo=null;
const cache=recoveryCache();
self.onmessage=async ({data:request})=>{
  const send=(type,value={})=>self.postMessage({type,id:request.id,...value});
  try {
    if(request.type==='load') {
      send('progress',{phase:'트래킹 결과 읽는 중'});
      let bytes;
      if(request.source instanceof Blob)bytes=await request.source.arrayBuffer();
      else {
        const response=await fetch(request.source);
        if(!response.ok)throw Error('트래킹 결과를 읽지 못했습니다.');
        bytes=await response.arrayBuffer();
      }
      contentHash=await digest(bytes);
      if(request.expectedHash&&contentHash!==request.expectedHash)throw Error('트래킹 파일이 변경되었습니다. 작업을 다시 열어 주세요.');
      send('progress',{phase:'트래킹 데이터 확인 중'});
      data=validateDataset(JSON.parse(new TextDecoder().decode(bytes)));
      baselineMemo=null;
      send('loaded',{contentHash,...(request.sendData?{data}:{})});
    } else if(request.type==='compute') {
      if(!data)throw Error('트래킹 결과를 먼저 열어 주세요.');
      const started=performance.now(),key=await recoveryCacheKey(contentHash,request.review),store=await cache;
      send('progress',{phase:'저장된 선수 연결 확인 중'});
      const cached=await store.get(key);
      if(cached){
        let cacheSaved=true;
        if(request.review.setup&&!cached.issues.length&&cached.checkpointPlan?.version!==CHECKPOINT_PLAN_VERSION){
          send('progress',{phase:'확인할 장면 추천 갱신'});
          const recovered=hydrateRecovery(cached,data);
          cached.checkpointPlan=planCheckpoints(recovered.data,request.review,effectiveSegments(request.review,recovered));
          cacheSaved=await store.put(key,cached);
        }
        send('complete',{result:cached,cacheHit:true,cacheSaved,elapsedMs:performance.now()-started});return;
      }
      let previous=0;
      const progress=info=>{
        const now=performance.now();
        if(now-previous<250&&info.completed!==0&&info.completed!==info.total)return;
        previous=now;send('progress',info);
      };
      let baseline=null;
      if(request.review.checkpoints?.length&&!request.review.shadowCorrection){
        const baseReview={...request.review,checkpoints:[]},baseKey=await recoveryCacheKey(contentHash,baseReview);
        if(baselineMemo?.key===baseKey)baseline=baselineMemo.result;
        else{
          const saved=await store.get(baseKey);
          if(saved){const {status,...rest}=hydrateRecovery(saved,data);baseline=rest;}
          else{baseline=reconnect(data,baseReview,progress);await store.put(baseKey,packRecovery(baseline,data));}
          baselineMemo={key:baseKey,result:baseline};
        }
        progress({phase:'저장된 기본 연결에 확인 장면 반영',completed:0,total:0});
      }
      const recovered=reconnect(data,request.review,progress,{baseline});
      if(!request.review.checkpoints?.length)baselineMemo={key,result:recovered};
      const result=packRecovery(recovered,data);
      send('progress',{phase:'선수 연결 결과 저장 중'});
      const cacheSaved=await store.put(key,result);
      send('complete',{result,cacheHit:false,cacheSaved,elapsedMs:performance.now()-started});
    }
  } catch(error){send('error',{message:error.message||String(error)});}
};
