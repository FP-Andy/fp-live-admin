import {heatmapSteps} from './heatmaps.mjs';
import {paintHeatmap,HEATMAP_EXPORT_SIZE} from './heatmap-render.mjs';
import {saveReport} from './report-store.mjs';
import {fpaDocument} from './fpa-events.mjs';
import {saveAnalysisSnapshot} from './analysis-snapshots.mjs';

export function heatmapUI({getData,getWorking,getRecovery,prepareSnapshot,message}) {
  const $=id=>document.getElementById(id);let result=null,revision=0,dirty=true;
  let saving=false,requestId=null,requestStamp=null;
  const completion=$('heatmap-complete'),dialog=$('analysis-complete-dialog'),confirm=$('analysis-complete-confirm');
  const save=(blob,name)=>{const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);};
  const minutes=n=>`${Math.floor(n/60)}:${String(Math.floor(n%60)).padStart(2,'0')}`;
  const gapTime=n=>n<60?`${n.toFixed(1)}초`:`${Math.floor(n/60)}분 ${(n%60).toFixed(1)}초`;
  const paint=(canvas,player)=>paintHeatmap(canvas,result,player);
  function exportCanvas(player){const canvas=document.createElement('canvas');canvas.width=HEATMAP_EXPORT_SIZE.width;paint(canvas,player);return canvas;}
  function render(){
    const holder=$('heatmap-cards');holder.replaceChildren();
    if(!result)return;
    for(const p of result.players){
      const article=document.createElement('article'),title=document.createElement('h3'),canvas=document.createElement('canvas'),button=document.createElement('button'),quality=document.createElement('p');
      title.className='heatmap-player';title.textContent=`${p.group==='home'?'홈':'원정'} #${p.jersey}${p.name?' '+p.name:''}`;
      canvas.width=660;canvas.setAttribute('aria-label',`${p.group==='home'?'홈':'원정'} ${p.jersey}번 히트맵 · 유효 관측률 ${(p.coverage*100).toFixed(1)}%`);paint(canvas,p);
      button.textContent='PNG 저장';button.onclick=()=>exportCanvas(p).toBlob(blob=>blob&&save(blob,`queens-cup-${p.group}-${p.jersey}-heatmap.png`));
      quality.className='heatmap-quality';quality.textContent=`유효 ${(p.coverage*100).toFixed(1)}% · ${minutes(p.observed)} / ${minutes(result.duration)} · 최장 빈 구간 ${gapTime(p.longestMissing)}`;
      article.append(title,canvas,quality,button);holder.append(article);
    }
    $('heatmap-status').textContent=`${result.resultVersion}차 결과 · 확인 ${result.confirmedScenes}장면 · 평균 유효 ${(result.players.reduce((n,p)=>n+p.coverage,0)/result.players.length*100).toFixed(1)}% · 최저 선수 ${(Math.min(...result.players.map(p=>p.coverage))*100).toFixed(1)}% · 교체 미반영`;
    $('heatmap-json').disabled=false;$('heatmap-report').disabled=false;$('heatmap-fcm').disabled=false;
    if(completion)completion.disabled=saving;
  }
  async function compute(){
    const data=getData(),working=getWorking();if(!data)return;
    if(getRecovery()?.status!=='complete'){message('선수 연결 계산이 완료된 뒤 히트맵을 만들 수 있습니다.',true);return;}
    if(!working.setup||getRecovery().issues.length){message('코트와 명단 13명 초기 설정을 완료하세요.',true);return;}
    const ticket=++revision;dirty=false;$('heatmap-build').disabled=true;result=null;render();$('heatmap-json').disabled=true;$('heatmap-report').disabled=true;$('heatmap-fcm').disabled=true;
    try{
      const steps=heatmapSteps(getRecovery().data||data,working,{point:$('heatmap-point').value,turn:Number($('heatmap-turn').value),manualOnly:$('heatmap-manual').checked});
      let next=steps.next();
      while(!next.done){$('heatmap-status').textContent=`관측 위치 집계 · ${Math.round(next.value.completed/next.value.total*100)}%`;await new Promise(requestAnimationFrame);if(ticket!==revision)return;next=steps.next();}
      if(ticket!==revision)return;
      result=next.value;
      // Fixed common density scale computed from the same smoothed grids.
      let peak=0;for(const p of result.players)for(let y=0;y<result.height;y++)for(let x=0;x<result.width;x++){
        let value=0;for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++){const xx=x+dx,yy=y+dy;if(xx>=0&&yy>=0&&xx<result.width&&yy<result.height)value+=p.grid[yy*result.width+xx]*Math.exp(-(dx*dx+dy*dy)/8);}
        peak=Math.max(peak,value);
      }
      result.scale=peak;render();
    }catch(error){dirty=true;$('heatmap-status').textContent=error.message;message(error.message,true);}
    finally{if(ticket===revision)$('heatmap-build').disabled=false;}
  }
  function invalidate(){++revision;dirty=true;result=null;requestId=null;if(completion)completion.disabled=true;if($('analysis-snapshot-link'))$('analysis-snapshot-link').hidden=true;dialog?.close();$('heatmap-cards').replaceChildren();$('heatmap-build').disabled=false;$('heatmap-json').disabled=true;$('heatmap-report').disabled=true;$('heatmap-fcm').disabled=true;$('heatmap-status').textContent='선수 연결을 계산한 뒤 히트맵 만들기를 누르세요.';}
  if(completion){
    completion.onclick=()=>{
      if(!result||getRecovery()?.status!=='complete'||saving)return;
      const players=result.players,eventCount=getWorking().events.length;
      $('analysis-complete-summary').textContent=`${result.resultVersion}차 · 평균 ${(players.reduce((s,p)=>s+p.coverage,0)/players.length*100).toFixed(1)}% · 최저 ${(Math.min(...players.map(p=>p.coverage))*100).toFixed(1)}% · FPA ${eventCount}건${eventCount?'':' (이벤트맵 비어 있음)'}`;
      $('analysis-complete-players').replaceChildren(...players.map(p=>{const row=document.createElement('li');row.textContent=`${p.group==='home'?'홈':'원정'} #${p.jersey} · ${(p.coverage*100).toFixed(1)}% · 최장 공백 ${gapTime(p.longestMissing)}`;return row;}));
      $('analysis-complete-checked').checked=false;confirm.disabled=true;dialog.showModal();
    };
    $('analysis-complete-checked').onchange=e=>{confirm.disabled=!e.target.checked||saving;};
    $('analysis-complete-cancel').onclick=()=>dialog.close();
    confirm.onclick=async()=>{
      if(!result||saving||!$('analysis-complete-checked').checked||getRecovery()?.status!=='complete')return;
      const captured=result,ticket=revision;requestId=requestId||crypto.randomUUID().replaceAll('-','');
      saving=true;confirm.disabled=true;completion.disabled=true;confirm.textContent='저장 중…';
      try{
        if(!prepareSnapshot)throw Error('FPC 분석 목록에서 작업을 열어 주세요.');
        const source=await prepareSnapshot();
        if(ticket!==revision||captured!==result)throw Error('히트맵이 변경되었습니다. 다시 확인하세요.');
        const stamp=JSON.stringify([source,revision]);if(requestStamp!==stamp){requestStamp=stamp;requestId=crypto.randomUUID().replaceAll('-','');}
        const saved=await saveAnalysisSnapshot({...source,requestId,confirmed:true,heatmap:captured});
        requestId=null;dialog.close();
        const link=$('analysis-snapshot-link');link.href=`/admin/fcm/futsal/reports?snapshot=${encodeURIComponent(saved.id)}`;link.textContent=`확정 v${saved.version} · FCM 리포트 열기`;link.hidden=false;
        message(`분석 완료 · 스냅샷 v${saved.version} 서버 저장됨. 이후 수정은 새 버전으로 확정할 수 있습니다.`);
      }catch(error){message(error.message,true);}
      finally{saving=false;confirm.textContent='완료 판정 · 스냅샷 저장';confirm.disabled=!$('analysis-complete-checked').checked;completion.disabled=!result;}
    };
  }
  $('heatmap-build').onclick=compute;
  for(const id of ['heatmap-point','heatmap-turn','heatmap-manual'])$(id).onchange=invalidate;
  $('heatmap-json').onclick=()=>{if(result)save(new Blob([JSON.stringify(result)],{type:'application/json'}),'fpa-heatmaps.json');};
  $('heatmap-fcm').onclick=async()=>{
    if(!result)return;
    if(location.protocol==='file:'||!location.pathname.startsWith('/fpa-cv/')){message('FPC 웹에서 열거나 좌표·품질 JSON을 FCM 리포트에 불러오세요.',true);return;}
    const popup=window.open('about:blank','_blank');
    if(!popup){message('새 탭을 열 수 없습니다. 팝업을 허용하거나 좌표·품질 JSON을 저장하세요.',true);return;}
    popup.opener=null;
    const id=crypto.randomUUID();
    try{await saveReport({id,kind:'source',title:result.video,updatedAt:new Date().toISOString(),heatmap:result,fpa:fpaDocument(getWorking())});popup.location.href=`/admin/fcm/futsal/reports?report=${encodeURIComponent(id)}`;}
    catch(error){popup.close();message(error.message,true);}
  };
  $('heatmap-report').onclick=()=>{
    if(!result)return;const report=document.createElement('canvas'),{width,height}=HEATMAP_EXPORT_SIZE;report.width=2*width;report.height=Math.ceil(result.players.length/2)*height;
    const ctx=report.getContext('2d');result.players.forEach((p,i)=>ctx.drawImage(exportCanvas(p),(i%2)*width,Math.floor(i/2)*height));
    report.toBlob(blob=>blob&&save(blob,'queens-cup-10-player-heatmaps.png'));
  };
  return {invalidate,open:()=>{if(dirty&&getData()&&getRecovery()?.status==='complete')void compute();}};
}
