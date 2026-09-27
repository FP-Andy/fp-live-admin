import {heatmapSteps} from './heatmaps.mjs';

export function heatmapUI({getData,getWorking,getRecovery,message}) {
  const $=id=>document.getElementById(id);let result=null,revision=0,dirty=true;
  const pitch=new Image();pitch.src='/scene/futsal-pitch.svg';
  const save=(blob,name)=>{const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);};
  const minutes=n=>`${Math.floor(n/60)}:${String(Math.floor(n%60)).padStart(2,'0')}`;
  const gapTime=n=>n<60?`${n.toFixed(1)}초`:`${Math.floor(n/60)}분 ${(n%60).toFixed(1)}초`;
  function paint(canvas,p,small=false){
    const ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height,pad=w/22,top=100,cw=w-2*pad,ch=cw/2;
    ctx.fillStyle='#131518';ctx.fillRect(0,0,w,h);
    ctx.fillStyle='#fff';ctx.font=`600 ${small?20:28}px sans-serif`;ctx.fillText(`${p.group==='home'?'홈':'원정'} #${p.jersey}${p.name?' '+p.name:''}`,pad,small?27:35);
    ctx.font=`${small?12:17}px sans-serif`;ctx.fillStyle='#b8bdc6';ctx.fillText(`유효 ${minutes(p.observed)} / ${minutes(result.duration)} · ${(p.coverage*100).toFixed(1)}% · 자동 ${minutes(p.automatic)}`,pad,small?47:61);
    if(pitch.complete&&pitch.naturalWidth)ctx.drawImage(pitch,0,top-pad,w,ch+2*pad);
    else {ctx.fillStyle='#007ac0';ctx.fillRect(pad,top,cw,ch);ctx.strokeStyle='#fff';ctx.strokeRect(pad,top,cw,ch);}
    // Gaussian kernel of about one metre on the 40 x 20 template. All player
    // images share a scale, so colour intensity can be compared within the run.
    const grid=new Float64Array(result.width*result.height);
    for(let y=0;y<result.height;y++)for(let x=0;x<result.width;x++){
      const value=p.grid[y*result.width+x];if(!value)continue;
      for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++){const xx=x+dx,yy=y+dy;if(xx>=0&&yy>=0&&xx<result.width&&yy<result.height)grid[yy*result.width+xx]+=value*Math.exp(-(dx*dx+dy*dy)/8);}
    }
    const max=result.scale||1;
    const density=document.createElement('canvas');density.width=result.width;density.height=result.height;
    const densityContext=density.getContext('2d'),pixels=densityContext.createImageData(result.width,result.height);
    for(let y=0;y<result.height;y++)for(let x=0;x<result.width;x++){
      const value=Math.min(1,grid[y*result.width+x]/max);if(value<.01)continue;
      const offset=(y*result.width+x)*4;pixels.data.set([255,Math.round(116+100*value),0,Math.round(255*.82*Math.sqrt(value))],offset);
    }
    densityContext.putImageData(pixels,0,0);ctx.imageSmoothingEnabled=true;ctx.drawImage(density,pad,top,cw,ch);
    ctx.strokeStyle='rgba(255,255,255,.8)';ctx.lineWidth=1;ctx.strokeRect(pad,top,cw,ch);ctx.beginPath();ctx.moveTo(w/2,top);ctx.lineTo(w/2,top+ch);ctx.moveTo(w/2+cw*3/40,top+ch/2);ctx.arc(w/2,top+ch/2,cw*3/40,0,Math.PI*2);ctx.stroke();
    ctx.fillStyle='#b8bdc6';ctx.font=`${small?11:14}px sans-serif`;
    ctx.fillText(`원본 ${minutes(result.from)}–${minutes(result.to)} · ${result.manualOnly?'수동 지정만':'자동 연결 포함 · 검수 필요'}`,pad,h-26);
    ctx.fillText(`${result.resultVersion}차 결과 · 교체 미반영 · 유효 관측률 ≠ 신원 정확도`,pad,h-8);
  }
  function render(){
    const holder=$('heatmap-cards');holder.replaceChildren();
    if(!result)return;
    for(const p of result.players){
      const article=document.createElement('article'),canvas=document.createElement('canvas'),button=document.createElement('button'),quality=document.createElement('p');
      canvas.width=660;canvas.height=500;canvas.setAttribute('aria-label',`${p.group==='home'?'홈':'원정'} ${p.jersey}번 히트맵 · 유효 관측률 ${(p.coverage*100).toFixed(1)}%`);paint(canvas,p);
      button.textContent='PNG 저장';button.onclick=()=>canvas.toBlob(blob=>blob&&save(blob,`${p.group}-${p.jersey}-heatmap.png`));
      quality.className='heatmap-quality';quality.textContent=`유효 ${(p.coverage*100).toFixed(1)}% · ${minutes(p.observed)} / ${minutes(result.duration)} · 최장 빈 구간 ${gapTime(p.longestMissing)}`;
      article.append(canvas,quality,button);holder.append(article);
    }
    $('heatmap-status').textContent=`${result.resultVersion}차 결과 · 확인 ${result.confirmedScenes}장면 · 평균 유효 ${(result.players.reduce((n,p)=>n+p.coverage,0)/result.players.length*100).toFixed(1)}% · 최저 선수 ${(Math.min(...result.players.map(p=>p.coverage))*100).toFixed(1)}% · 교체 미반영`;
    $('heatmap-json').disabled=false;$('heatmap-report').disabled=false;
  }
  async function compute(){
    const data=getData(),working=getWorking();if(!data)return;
    if(getRecovery()?.status!=='complete'){message('선수 연결 계산이 완료된 뒤 히트맵을 만들 수 있습니다.',true);return;}
    if(!working.setup||getRecovery().issues.length){message('코트와 명단 13명 초기 설정을 완료하세요.',true);return;}
    const ticket=++revision;dirty=false;$('heatmap-build').disabled=true;result=null;render();$('heatmap-json').disabled=true;$('heatmap-report').disabled=true;
    try{
      await pitch.decode().catch(()=>{});
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
  function invalidate(){++revision;dirty=true;result=null;$('heatmap-cards').replaceChildren();$('heatmap-build').disabled=false;$('heatmap-json').disabled=true;$('heatmap-report').disabled=true;$('heatmap-status').textContent='선수 연결을 계산한 뒤 히트맵 만들기를 누르세요.';}
  $('heatmap-build').onclick=compute;
  for(const id of ['heatmap-point','heatmap-turn','heatmap-manual'])$(id).onchange=invalidate;
  $('heatmap-json').onclick=()=>{if(result)save(new Blob([JSON.stringify(result)],{type:'application/json'}),'fpa-heatmaps.json');};
  $('heatmap-report').onclick=()=>{
    if(!result)return;const report=document.createElement('canvas');report.width=1320;report.height=5*500;
    const ctx=report.getContext('2d');result.players.forEach((p,i)=>{const tile=document.createElement('canvas');tile.width=660;tile.height=500;paint(tile,p,true);ctx.drawImage(tile,(i%2)*660,Math.floor(i/2)*500);});
    report.toBlob(blob=>blob&&save(blob,'fpa-10-player-heatmaps.png'));
  };
  return {invalidate,open:()=>{if(dirty&&getData()&&getRecovery()?.status==='complete')void compute();}};
}
