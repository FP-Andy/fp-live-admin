import {GROUPS,defaultRoster} from './core.mjs';
import {samplePatch,hex} from './colors.mjs';
import {courtPosition} from './boundary.mjs';
const $=id=>document.getElementById(id);
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const inks={home:'#ffac70',away:'#73b6ff',referee:'#ebe7a9'};
export function validCourt(points){
 if(points.length!==4)return false;
 const cross=points.map((p,i)=>{const b=points[(i+1)%4],c=points[(i+2)%4];return (b[0]-p[0])*(c[1]-b[1])-(b[1]-p[1])*(c[0]-b[0]);});
 return cross.every(n=>n>1e-6)||cross.every(n=>n< -1e-6);
}
export function preflight({video,status,change,isBusy}){
 let points=[],drawing=false,drag=null,prepared=null,preparationId=null,uniforms={},roster=[],activePerson=null,selectedBox=null,picking=null;
 const snapshot=$('tracking-prepared'),svg=$('tracking-roi'),original=document.createElement('canvas'),ctx=original.getContext('2d',{willReadFrequently:true}),crop=$('preflight-crop'),cropCtx=crop.getContext('2d');
 const rosterNodes=new Map(),paletteNodes=new Map();
 let excluded=new Set(),removed=[];
 let cropMap=null;
 const name=p=>`${GROUPS[p.group].label} ${p.group==='referee'?p.jersey||'REF':p.jersey?'No.'+p.jersey:'번호 미입력'}`;
 function problems(){
  const issues=[];
  if(!validCourt(points))issues.push('코트 네 꼭짓점');
  if(!prepared)issues.push('초기 장면 선수 검출');
  if(Object.values(uniforms).some(samples=>!samples.length))issues.push('유니폼 5그룹 색상');
  if(roster.some(p=>!Number.isInteger(p.detectionId)))issues.push('13명 박스 연결');
  if(roster.some(p=>!new RegExp(p.group==='referee'?'^[\\w가-힣-]{1,12}$':'^[0-9]{1,3}$').test(p.jersey)))issues.push('13명 등번호');
  for(const team of ['home','away']){const values=roster.filter(p=>GROUPS[p.group].team===team&&p.jersey).map(p=>Number(p.jersey));if(new Set(values).size!==values.length)issues.push(`${team==='home'?'홈':'어웨이'} 등번호 중복`);}
  return issues;
 }
 function notify(){
  const issues=problems();$('preflight-check').textContent=issues.length?'설정 필요 · '+issues.join(' · '):'초기 설정 완료 · 이 코트와 유니폼으로 추적합니다.';
  $('preflight-count').textContent=`${roster.filter(p=>Number.isInteger(p.detectionId)).length} / 13`;
  $('preflight-hint').textContent=drawing?`경기장 선을 따라 꼭짓점 ${points.length+1}/4 클릭`:picking?`${GROUPS[picking].label} 유니폼을 영상이나 확대 화면에서 클릭`:activePerson?`${name(roster.find(p=>p.id===activePerson))}의 영상 박스를 클릭`:prepared?'명단 선택 → 영상 박스 연결 · 박스만 누르면 확대':'13명이 잘 보이는 장면에서 선수 찾기를 누르세요';
  $('tracking-pick-layer').hidden=!picking;
  crop.classList.toggle('picking',!!picking);
  boxTools();
  change();
 }
 function boxTools(){
  $('preflight-box-tools').hidden=!prepared;
  const select=$('preflight-box-select');select.replaceChildren(new Option('영상에서 BB 선택',''));
  for(const b of prepared?.boxes||[]){const person=roster.find(p=>p.detectionId===b.id);select.append(new Option(`#${b.id} · ${(b.confidence*100).toFixed(0)}%${excluded.has(b.id)?' · 제외됨':person?' · '+name(person):''}`,b.id));}
  select.value=selectedBox??'';
  $('preflight-exclude-box').disabled=!prepared||selectedBox===null;
  $('preflight-exclude-box').textContent=excluded.has(selectedBox)?'선택 BB 복원':'선택 BB 제외';
  $('preflight-restore-box').disabled=!removed.some(id=>excluded.has(id));
  $('preflight-excluded-count').textContent=excluded.size;
 }
 function selectBox(id){
  if(isBusy()||!prepared?.boxes.some(b=>b.id===id))return;
  selectedBox=id;activePerson=null;picking=null;drawing=false;palettes();updateRoster();drawCourt();drawCrop();
 }
 function restoreBox(id){
  if(isBusy()||!excluded.delete(id))return;
  removed=removed.filter(n=>n!==id);selectBox(id);
  $('preflight-box-note').textContent=`#${id} 복원됨 · 필요한 선수 번호를 다시 연결하세요.`;
 }
 $('preflight-box-select').onchange=event=>{if(event.target.value)selectBox(Number(event.target.value));};
 $('preflight-exclude-box').onclick=()=>{
  if(isBusy()||selectedBox===null)return;
  if(excluded.has(selectedBox)){restoreBox(selectedBox);return;}
  const linked=roster.find(p=>p.detectionId===selectedBox);
  excluded.add(selectedBox);removed.push(selectedBox);
  if(linked)linked.detectionId=null;
  activePerson=null;picking=null;palettes();updateRoster();drawBoxes();drawCrop();notify();
  $('preflight-box-note').textContent=`#${selectedBox} 초기 BB 제외됨${linked?' · '+name(linked)+'을 다른 BB에 다시 연결하세요.':' · 이후 새로 검출되는 BB는 작업 화면에서 제외할 수 있습니다.'}`;
 };
 $('preflight-restore-box').onclick=()=>{const id=removed.findLast(n=>excluded.has(n));if(id!==undefined)restoreBox(id);};
 $('preflight-show-excluded').onchange=()=>{drawBoxes();};
 function drawCourt(){
  svg.replaceChildren();
  const add=(tag,attrs)=>{const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v]of Object.entries(attrs))n.setAttribute(k,v);svg.append(n);return n;};
  if(points.length===4)add('path',{d:'M0 0H100V100H0Z M'+points.map(([x,y])=>`${x*100} ${y*100}`).join('L')+'Z','fill-rule':'evenodd',class:'court-shade'});
  if(points.length)add(points.length===4?'polygon':'polyline',{points:points.map(([x,y])=>`${x*100},${y*100}`).join(' '),class:validCourt(points)?'':'invalid'});
  points.forEach(([x,y],i)=>{add('circle',{cx:x*100,cy:y*100,r:1,'data-corner':i});const t=add('text',{x:x*100+1.5,y:y*100-1});t.textContent=i+1;});
  svg.classList.toggle('drawing',drawing);
  $('roi-start').textContent=drawing?'코트 지정 중':'코트 다시 지정';
  $('roi-status').textContent=validCourt(points)?'코트 설정됨 · 꼭짓점을 드래그해 조정':points.length===4?'선이 교차합니다. 테두리 순서대로 다시 지정하세요.':'경기장 선의 네 꼭짓점을 지정하세요';
  drawBoxes();notify();
 }
 const coordinates=event=>{const r=svg.getBoundingClientRect();return [Math.max(0,Math.min(1,(event.clientX-r.left)/r.width)),Math.max(0,Math.min(1,(event.clientY-r.top)/r.height))];};
 svg.onpointerdown=event=>{
  if(isBusy()||picking)return;
  if(drawing){event.preventDefault();points.push(coordinates(event));if(points.length===4)drawing=false;drawCourt();return;}
  const index=event.target.getAttribute('data-corner');if(index===null)return;
  event.preventDefault();drag=Number(index);svg.setPointerCapture(event.pointerId);
 };
 svg.onpointermove=event=>{if(drag===null||isBusy())return;points[drag]=coordinates(event);drawCourt();};
 svg.onpointerup=svg.onpointercancel=()=>{drag=null;};
 $('roi-start').onclick=()=>{if(isBusy())return;video.pause();points=[];drawing=true;picking=null;activePerson=null;palettes();updateRoster();drawCourt();};
 $('roi-clear').onclick=()=>{if(isBusy())return;points=[];drawing=true;picking=null;activePerson=null;palettes();updateRoster();drawCourt();};
 function drawCrop(){
  cropCtx.clearRect(0,0,crop.width,crop.height);cropMap=null;
  const b=prepared?.boxes.find(b=>b.id===selectedBox);if(!b)return;
  const [x1,y1,x2,y2]=b.box,pad=(x2-x1)*.5;
  const x=Math.max(0,x1-pad)*original.width,y=Math.max(0,y1-pad)*original.height,w=Math.min(original.width-x,(x2-x1+pad*2)*original.width),h=Math.min(original.height-y,(y2-y1+pad*2)*original.height),scale=Math.min(crop.width/w,crop.height/h);
  cropMap={x,y,w,h,dx:(crop.width-w*scale)/2,dy:(crop.height-h*scale)/2,scale};
  cropCtx.drawImage(original,x,y,w,h,cropMap.dx,cropMap.dy,w*scale,h*scale);
  cropCtx.strokeStyle=excluded.has(b.id)?'#96a0af':'#ff7400';cropCtx.lineWidth=2;
  cropCtx.strokeRect(cropMap.dx+(x1*original.width-x)*scale,cropMap.dy+(y1*original.height-y)*scale,(x2-x1)*original.width*scale,(y2-y1)*original.height*scale);
 }
 function drawBoxes(){
  const holder=$('tracking-seed-boxes');holder.replaceChildren();if(!prepared)return;
  for(const b of prepared.boxes){
   if(excluded.has(b.id)&&!$('preflight-show-excluded').checked)continue;
   const person=roster.find(p=>p.detectionId===b.id),outside=courtPosition(b.box,points,prepared.width/prepared.height)?.inside===false;
   const button=el('button',undefined,`seed-box${selectedBox===b.id?' selected':''}${person?' assigned':''}${outside?' outside':''}${excluded.has(b.id)?' excluded':''}`);button.type='button';button.dataset.detectionId=b.id;
   button.setAttribute('aria-label',excluded.has(b.id)?`제외 BB ${b.id}`:person?name(person):`초기 검출 ${b.id}${outside?' · 코트 밖':''}`);
   button.title=`${outside?'코트 밖':'코트 안'} · 검출 ${(b.confidence*100).toFixed(0)}%`;
   const [x1,y1,x2,y2]=b.box;button.style.cssText=`left:${x1*100}%;top:${y1*100}%;width:${(x2-x1)*100}%;height:${(y2-y1)*100}%;z-index:${selectedBox===b.id?101:Math.round(b.confidence*100)};--seed-ink:${excluded.has(b.id)?'#96a0af':person?inks[GROUPS[person.group].team]:outside?'#8797ac':'#ff7400'}`;
   button.append(el('span',excluded.has(b.id)?`제외 #${b.id}`:person?name(person):`${outside?'경계 ':''}#${b.id}`));
   button.onclick=()=>{
    if(isBusy()||drawing||picking)return;selectedBox=b.id;
    if(activePerson&&!excluded.has(b.id)){for(const p of roster)if(p.detectionId===b.id)p.detectionId=null;roster.find(p=>p.id===activePerson).detectionId=b.id;activePerson=null;}
    updateRoster();drawBoxes();drawCrop();notify();
   };holder.append(button);
  }
 }
 function updateRoster(){for(const p of roster){const row=rosterNodes.get(p.id);if(!row)continue;row.button.classList.toggle('active',activePerson===p.id);row.button.classList.toggle('assigned',Number.isInteger(p.detectionId));row.button.textContent=p.detectionId?`✓ #${p.detectionId}`:'박스 연결';row.clear.disabled=!p.detectionId;}}
 function makeRoster(){
  const holder=$('preflight-roster');holder.replaceChildren();rosterNodes.clear();
  for(const [group,info]of Object.entries(GROUPS)){
   const section=el('div',undefined,'seed-group');section.append(el('h4',info.label));
   for(const [i,p]of roster.filter(p=>p.group===group).entries()){
    const row=el('div',undefined,'seed-row'),input=el('input'),button=el('button','박스 연결'),clear=el('button','×');
    input.value=p.jersey;input.placeholder=group==='referee'?'REF':'등번호';input.inputMode=group==='referee'?'text':'numeric';input.maxLength=group==='referee'?12:3;input.setAttribute('aria-label',`${info.label} ${i+1} 등번호`);input.dataset.person=p.id;
    const select=()=>{picking=null;palettes();drawing=false;activePerson=p.id;selectedBox=p.detectionId||selectedBox;updateRoster();drawCourt();drawCrop();notify();};
    input.onfocus=select;input.oninput=()=>{p.jersey=input.value.trim();drawBoxes();notify();};button.type=clear.type='button';button.dataset.person=p.id;button.setAttribute('aria-label',`${info.label} ${i+1} 박스 연결`);button.onclick=select;
    clear.setAttribute('aria-label',`${info.label} ${i+1} 연결 해제`);clear.onclick=()=>{p.detectionId=null;updateRoster();drawBoxes();notify();};
    row.append(input,button,clear);section.append(row);rosterNodes.set(p.id,{button,input,clear});
   }holder.append(section);
  }updateRoster();
 }
 function palettes(){
  for(const [group,nodes]of paletteNodes){
   nodes.swatches.replaceChildren();uniforms[group].forEach((rgb,i)=>{const b=el('button','×');b.type='button';b.style.background=hex(rgb);b.title=hex(rgb)+' · 제거';b.setAttribute('aria-label',`${GROUPS[group].label} 색상 ${i+1} 제거`);b.onclick=()=>{uniforms[group].splice(i,1);palettes();notify();};nodes.swatches.append(b);});
   nodes.pick.textContent=picking===group?'선택 취소':uniforms[group].length?'색상 추가':'스포이드';nodes.pick.disabled=!prepared||uniforms[group].length>=8;
  }
 }
 function makePalettes(){
  const holder=$('preflight-uniforms');holder.replaceChildren();paletteNodes.clear();
  for(const [group,info]of Object.entries(GROUPS)){const row=el('div',undefined,'seed-palette'),swatches=el('div',undefined,'seed-swatches'),pick=el('button','스포이드');pick.type='button';pick.dataset.pickGroup=group;pick.setAttribute('aria-label',`${info.label} 초기 유니폼 스포이드`);pick.onclick=()=>{if(isBusy())return;picking=picking===group?null:group;drawing=false;activePerson=null;updateRoster();drawCourt();palettes();notify();};row.append(el('b',info.label),swatches,pick);holder.append(row);paletteNodes.set(group,{swatches,pick});}
  palettes();
 }
 function take(x,y){if(!picking||isBusy())return;try{uniforms[picking].push(samplePatch(ctx,x,y,original.width,original.height));picking=null;palettes();notify();}catch(error){status(error.message,true);}}
 $('tracking-pick-layer').onclick=event=>{const r=event.currentTarget.getBoundingClientRect();take((event.clientX-r.left)/r.width*original.width,(event.clientY-r.top)/r.height*original.height);};
 crop.onclick=event=>{if(!cropMap||!picking)return;const r=crop.getBoundingClientRect(),x=(event.clientX-r.left)/r.width*crop.width,y=(event.clientY-r.top)/r.height*crop.height;const m=cropMap;if(x<m.dx||x>m.dx+m.w*m.scale||y<m.dy||y>m.dy+m.h*m.scale)return;take(m.x+(x-m.dx)/m.scale,m.y+(y-m.dy)/m.scale);};
 function clearFrame(keepImage=false){prepared=null;preparationId=null;excluded=new Set();removed=[];$('preflight-show-excluded').checked=false;roster.forEach(p=>p.detectionId=null);picking=null;activePerson=null;selectedBox=null;cropMap=null;snapshot.hidden=!keepImage;video.hidden=keepImage;$('preflight-config').hidden=true;$('choose-initial-frame').hidden=true;$('detect-initial-frame').hidden=false;$('initial-frame-time').readOnly=false;$('tracking-seed-boxes').replaceChildren();makeRoster();drawCrop();notify();}
 function reset(){points=[];drawing=true;uniforms=Object.fromEntries(Object.keys(GROUPS).map(g=>[g,[]]));roster=defaultRoster().map(p=>({...p,detectionId:null}));clearFrame();makePalettes();drawCourt();}
 async function setPrepared(data,id,url){
  excluded=new Set();removed=[];$('preflight-show-excluded').checked=false;$('preflight-box-note').textContent='그림자를 포함한 큰 BB를 제외하고, 몸에 맞는 BB에 번호를 연결하세요.';
  snapshot.src=url;await snapshot.decode();$('initial-frame-time').value=data.time.toFixed(3);$('initial-frame-time').readOnly=true;prepared=data;preparationId=id;video.pause();video.hidden=true;snapshot.hidden=false;original.width=data.width;original.height=data.height;ctx.drawImage(snapshot,0,0);roster.forEach(p=>p.detectionId=null);activePerson=null;selectedBox=null;picking=null;drawing=!validCourt(points);
  $('preflight-config').hidden=false;$('choose-initial-frame').hidden=false;$('detect-initial-frame').hidden=true;$('preflight-frame-time').textContent=`초기 장면 ${data.time.toFixed(3)}초 · ${data.boxes.length}개 검출`;
  makeRoster();palettes();drawCourt();notify();
 }
 return {reset,clearFrame,setPrepared,issues:problems,roi:()=>points.map(p=>[...p]),time:()=>prepared?.time,
  setup:()=>({preparationId,excludedDetectionIds:[...excluded],uniforms:structuredClone(uniforms),roster:roster.map(({id,group,jersey,detectionId})=>({id,group,jersey,detectionId}))})};
}
