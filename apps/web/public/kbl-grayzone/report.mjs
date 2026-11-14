const W=1240,H=1754,NAVY='#00064f',ORANGE='#ff4c05',INK='#222b42',MUTED='#697387';
const font=(size,bold=false)=>`${bold?700:400} ${size}px "KBL Jump"`;
const image=src=>new Promise((resolve,reject)=>{const im=new Image();im.onload=()=>resolve(im);im.onerror=()=>reject(Error('리포트 이미지를 불러오지 못했습니다.'));im.src=src;});
const clock=t=>`${String(Math.floor(t/60)).padStart(2,'0')}:${(t%60).toFixed(2).padStart(5,'0')}`;
function text(ctx,value,x,y,size=23,color=INK,bold=false){ctx.font=font(size,bold);ctx.fillStyle=color;ctx.fillText(String(value),x,y);}
function fitText(ctx,value,x,y,width,size,color=MUTED){
  while(size>12){ctx.font=font(size);if(ctx.measureText(value).width<=width)break;size-=.5;}
  if(ctx.measureText(value).width>width)throw Error('작성자 또는 표시 문구가 너무 깁니다. 문구를 줄여 주세요.');
  text(ctx,value,x,y,size,color);
}
function wrap(ctx,value,x,y,width,size=23,line=33,maxLines=8){
  ctx.font=font(size);ctx.fillStyle=INK;let rows=[],current='';
  for(const ch of String(value||'')){
    if(ch==='\n'){rows.push(current);current='';continue;}
    if(ctx.measureText(current+ch).width>width){rows.push(current);current='';}current+=ch;
  }rows.push(current);
  if(rows.length>maxLines)throw Error('리포트의 제목이나 의견이 너무 깁니다. 문구를 줄여 주세요.');
  rows.forEach((row,i)=>ctx.fillText(row,x,y+i*line));return rows.length*line;
}
function box(ctx,x,y,w,h,color='#f4f5f8'){ctx.fillStyle=color;ctx.fillRect(x,y,w,h);}
function fitted(ctx,im,x,y,w,h,bg='#f4f5f8'){
  box(ctx,x,y,w,h,bg);const scale=Math.min(w/im.width,h/im.height);
  ctx.drawImage(im,x+(w-im.width*scale)/2,y+(h-im.height*scale)/2,im.width*scale,im.height*scale);
}
function page(logo,index,total,stamp){
  const c=document.createElement('canvas');c.width=W;c.height=H;const ctx=c.getContext('2d');
  box(ctx,0,0,W,H,'#fff');box(ctx,0,0,W,12,ORANGE);ctx.drawImage(logo,72,57,100,60.31);
  text(ctx,'COURTSIDE REVIEW',200,91,22,NAVY,true);text(ctx,'FINEPLAY · KBL',938,91,19,MUTED);
  box(ctx,72,146,1096,2,'#e2e5ec');box(ctx,72,1650,1096,2,'#e2e5ec');
  text(ctx,'검토 초안 · 위치 기반 시야 모델 / 실제 시선·판정 결론 아님',72,1692,18,MUTED);
  text(ctx,`${index} / ${total}`,1090,1692,20,NAVY,true);fitText(ctx,stamp,72,1722,1096,16);
  return {c,ctx};
}
export async function renderReportPages(report){
  await document.fonts.ready;
  await Promise.all([document.fonts.load(font(23)),document.fonts.load(font(42,true)),document.fonts.load('800 62px "KBL Court"')]);
  const logo=await image('./assets/kbl-ci.svg'),total=report.scenes.length+1;
  const stamp=`생성 ${new Date(report.createdAt).toLocaleString('ko-KR')} · 작성 ${report.reviewer||'미입력'}`;
  const pages=[],cover=page(logo,1,total,stamp),ctx=cover.ctx;
  text(ctx,'MATCH REVIEW REPORT',72,222,22,ORANGE,true);
  ctx.font='800 62px "KBL Court"';ctx.fillStyle=NAVY;ctx.fillText('판독 장면 리포트',72,310);
  wrap(ctx,report.title||report.scenes[0].game,72,384,1096,33,45,2);
  text(ctx,`${report.scenes[0].date} · ${report.scenes[0].game}`,72,467,23,MUTED);
  for(const [i,label,value] of [[0,'판독 장면',`${report.scenes.length}개`],[1,'자료 상태','검토 초안'],[2,'기준','영상·추적 동기화']]){
    const x=72+i*373;box(ctx,x,515,350,139);box(ctx,x,515,350,5,i===0?ORANGE:NAVY);
    text(ctx,label,x+23,561,20,MUTED);text(ctx,value,x+23,612,31,NAVY,true);
  }
  text(ctx,'경기 심판: '+(report.scenes[0].roster||[]).map(r=>`#${r.number} ${r.name}`).join(' · ')+'  / 영상 인물 연결 별도',72,694,19,MUTED);
  text(ctx,'검토 장면 목록',72,733,29,NAVY,true);
  report.scenes.forEach((s,i)=>{const y=784+i*65;box(ctx,72,y+24,1096,1,'#e6e8ee');text(ctx,String(i+1).padStart(2,'0'),78,y,24,ORANGE,true);text(ctx,`클립 ${s.clipNumber} · ${clock(s.time)}`,145,y,24,NAVY);text(ctx,`원본 녹화 ${clock(s.recordingTime)}`,510,y,21,MUTED);text(ctx,`${i+2}p`,1110,y,22,NAVY);});
  box(ctx,72,1480,1096,116,'#fff5ef');text(ctx,'읽기 전 확인',96,1518,22,ORANGE,true);
  text(ctx,'공 미확인 구간은 공 위치를 확정하지 않습니다. A·B·C와 심판 실명 연결도 별도 검수 대상입니다.',96,1554,19,INK);
  text(ctx,'코트 보정·신체 크기·방향·공 높이 가정과 자료 버전을 각 장면에 함께 기록합니다.',96,1582,19,INK);
  pages.push(cover.c);
  for(const [i,s] of report.scenes.entries()){
    const {c,ctx}=page(logo,i+2,total,stamp);
    text(ctx,`SCENE ${String(i+1).padStart(2,'0')} / 클립 ${s.clipNumber}`,72,199,22,ORANGE,true);
    text(ctx,`${clock(s.time)}  판독 장면`,72,254,43,NAVY,true);
    text(ctx,`원본 ${clock(s.recordingTime)} · 프레임 ${s.frameIndex} · ${s.sourceLabel}`,72,292,20,MUTED);
    fitted(ctx,await image(s.images.original),72,322,1096,465,'#111932');
    text(ctx,'01  원본 영상 · 객체 표시',72,822,21,NAVY,true);
    const map=await image(s.images.map),three=await image(s.images.three);
    fitted(ctx,map,72,855,340,340);fitted(ctx,three,436,855,732,340);
    text(ctx,'02  2D 코트 · 현재 검토 보기',72,1230,19,NAVY,true);
    text(ctx,'03  3D 재구현 · '+s.cameraLabel,436,1230,19,NAVY,true);
    box(ctx,72,1276,1096,136,'#f4f5f8');
    text(ctx,`심판 ${s.activeRef} · 모델상 가시 비율 ${s.visibility==null?'미확인':Math.round(s.visibility*100)+'%'}`,94,1308,23,NAVY,true);
    text(ctx,`공: ${s.ballLabel} | 방향: ${s.headingLabel} | 시야각 ${s.config.hfov}° | ${s.simulationLabel||'기준 위치'}`,94,1340,18,MUTED);
    if(s.bodyModel)text(ctx,`MPFB · 선수 ${s.bodyModel.playerHeight.toFixed(2)} m / 심판 ${s.bodyModel.refereeHeight.toFixed(2)} m · 너비 ${Math.round(s.bodyModel.widthScale*100)}% · ${s.poseEstimate?`영상 자세 ${s.poseEstimate.appliedCount}/${s.poseEstimate.total}명 · 깊이 추정`:s.bodyModel.pose==='wide'?'팔 벌림 가정':'기본 자세 가정'} · 동일 메시 가림`,94,1371,17,MUTED);
    if(s.bodyContext){const b=s.bodyContext,textDirection=b.mode==='context'?`공격·수비 비교 가정 · ${b.attackTeam==='unknown'?'공격팀 미확인':b.attackTeam==='home'?'홈 공격':'어웨이 공격'} · ${b.basket==='left'?'왼쪽':'오른쪽'} 골대`:'영상 몸 방향 우선 · 골대 방향 강제 없음';text(ctx,`${textDirection} · 2D ${s.poseEstimate?.manualJointCount||0}관절 / 3D ${s.poseEstimate?.manualArmCount||0}팔 보정 · 기본 ${s.poseEstimate?.armFallbackCount||0}팔`,94,1396,16,MUTED);}
    text(ctx,'검토 의견',72,1435,25,NAVY,true);
    wrap(ctx,s.note||'검토 의견 미입력. 원본 영상과 위치·역할·방향을 확인한 뒤 의견을 작성하세요.',72,1463,1096,22,29,5);
    text(ctx,`코트 보정: 임시 · 공 높이 ${s.ballHeight} m 가정 · 신원 ${s.identityLabel}`,72,1622,17,MUTED);
    text(ctx,`자료 ${String(s.datasetId).slice(0,55)} · ${s.analysisSource} · 인체 ${s.bodyModel?.id||"기존 모델"}`,72,1641,14,MUTED);
    pages.push(c);
  }
  return pages;
}

// The same frame may be captured from another camera or with another geometry assumption.
export const reportSceneKey=s=>JSON.stringify([s.clipId,s.datasetId,s.frameIndex,s.cameraLabel,s.activeRef,s.headingMode,s.config,s.target,s.offsets,s.headings,s.bodyModel?.geometrySha256,s.poseEstimate?.meshSha256,s.poseEstimate?.jobId,s.poseEstimate?.pipelineVersion,s.bodyContext,s.gazeReviews]);
export function installReport({capture,toast}){
  const dialog=document.createElement('dialog');dialog.className='report-dialog';dialog.id='reportDialog';
  dialog.innerHTML=`<header><div><span class="eyebrow">KBL REVIEW REPORT</span><h2>판독 장면 리포트</h2></div><button id="reportClose" class="plain" aria-label="리포트 닫기">닫기 ×</button></header><p>같은 경기에서 최대 10개 장면을 담아 A4 PDF로 저장합니다. 현재 화면을 고정해 원본·2D·3D와 검토 의견을 함께 기록합니다.</p><div class="report-fields"><label>리포트 제목<input id="reportTitle" maxlength="80" placeholder="경기별 판독 장면 검토"></label><label>작성자<input id="reportReviewer" maxlength="60" placeholder="작성자 이름"></label></div><div class="report-actions"><button id="reportAdd" class="secondary">현재 장면 담기</button><button id="reportPreview" class="secondary">미리보기</button><button id="reportPdf" class="primary">PDF 다운로드</button></div><p id="reportStatus" role="status">장면을 담으면 아래 목록에 표시됩니다.</p><div id="reportScenes"></div><div id="reportPages" aria-label="리포트 미리보기"></div>`;
  document.body.append(dialog);
  const $=id=>dialog.querySelector('#'+id);let scenes=[],busy=false;
  const status=message=>{$('reportStatus').textContent=message;};
  const locked=value=>{busy=value;for(const id of ['reportAdd','reportPreview','reportPdf','reportTitle','reportReviewer'])$(id).disabled=value;dialog.querySelectorAll('textarea').forEach(e=>e.disabled=value);};
  const report=()=>({schema:'kbl-report/v1',createdAt:new Date().toISOString(),title:$('reportTitle').value,reviewer:$('reportReviewer').value,scenes:structuredClone(scenes)});
  function list(){
    $('reportScenes').replaceChildren();$('reportPages').replaceChildren();
    scenes.forEach((s,i)=>{
      const row=document.createElement('section');row.className='report-scene';
      const img=new Image();img.src=s.images.original;img.alt=`장면 ${i+1} 원본`;
      const panel=document.createElement('div'),heading=document.createElement('strong');heading.textContent=`${i+1}. 클립 ${s.clipNumber} · ${clock(s.time)} · ${s.cameraLabel}`;
      const note=document.createElement('textarea');note.maxLength=250;note.rows=3;note.value=s.note||'';note.placeholder='검토 의견 (최대 250자)';note.setAttribute('aria-label',`장면 ${i+1} 검토 의견`);note.oninput=()=>{s.note=note.value;$('reportPages').replaceChildren();};
      const remove=document.createElement('button');remove.className='plain';remove.textContent='삭제';remove.onclick=()=>{if(!busy){scenes.splice(i,1);list();}};
      panel.append(heading,note);row.append(img,panel,remove);$('reportScenes').append(row);
    });status(`${scenes.length}/10개 장면 · PDF ${scenes.length+1}페이지 · 검토 초안`);
  }
  async function add(){if(busy)return;locked(true);try{
    if(scenes.length>=10)throw Error('최대 10개 장면을 담을 수 있습니다.');
    const s=await capture();if(scenes.length&&scenes[0].matchKey!==s.matchKey)throw Error('다른 경기는 기존 장면을 모두 삭제한 뒤 담아주세요.');
    if(scenes.some(x=>reportSceneKey(x)===reportSceneKey(s)))throw Error('같은 시점·보기·모델 설정을 이미 담았습니다.');
    scenes.push(s);if(!$('reportTitle').value)$('reportTitle').value=s.game+' 판독 장면';list();
  }catch(e){status(e.message);}finally{locked(false);}}
  async function exportPages(download){if(busy)return;locked(true);try{
    if(!scenes.length)throw Error('먼저 현재 장면을 담아주세요.');status('리포트 페이지를 생성하고 있습니다.');
    const snapshot=report(),pages=await renderReportPages(snapshot);$('reportPages').replaceChildren(...pages);status(`${pages.length}페이지 미리보기 · 검토 초안`);
    if(download){
      const payload={...snapshot,scenes:snapshot.scenes.map(({images,...rest})=>rest),pages:pages.map(c=>c.toDataURL('image/jpeg',.94))};
      const response=await fetch('/api/reports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const result=await response.json();if(!response.ok)throw Error(result.error||'PDF 생성에 실패했습니다.');
      const a=document.createElement('a');a.href=result.pdf;a.download='kbl-review-report.pdf';a.click();
      status(`${result.pageCount}페이지 PDF를 저장했습니다. 원본 검토 데이터 JSON도 함께 보관했습니다.`);toast('KBL 판독 리포트 PDF를 생성했습니다.');
      const link=document.createElement('a');link.href=result.json;link.download='kbl-review-report.json';link.textContent='검토 데이터 JSON 다운로드';$('reportPages').prepend(link);
    }
  }catch(e){status(e.message);}finally{locked(false);}}
  document.getElementById('report').onclick=()=>{dialog.showModal();};
  $('reportClose').onclick=()=>dialog.close();$('reportAdd').onclick=add;
  $('reportPreview').onclick=()=>exportPages(false);$('reportPdf').onclick=()=>exportPages(true);
}
