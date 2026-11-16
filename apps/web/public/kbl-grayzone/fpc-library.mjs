import {$,api,dateText,node,uuid} from './fpc-ui.mjs';
import {recordingPreviewUrl} from './fpc-recording-relay.mjs';
import {fetchFirstRecording,reportCompletion} from './fpc-library-card.mjs';
const PAGE_SIZE=10;
let matches=[],total=0,page=1,requestId=0,searchTimer=null,observer=null,active=0;
const details=new Map(),queue=[];
function limited(task){return new Promise((resolve,reject)=>{queue.push({task,resolve,reject});drain();});}
function drain(){while(active<4&&queue.length){const item=queue.shift();active++;Promise.resolve().then(item.task).then(item.resolve,item.reject).finally(()=>{active--;drain();});}}
function stats(){
 $('catalogStats').replaceChildren(...[[String(total),$('matchSearch').value.trim()?'검색 결과':'FPC 경기'],[String(matches.length),'현재 페이지 경기']].map(([v,l])=>{const n=node('div','catalog-stat');n.append(node('strong','',v),node('span','',l));return n;}));
}
async function reportStatus(mid){
 const response=await api(`/api/courtside/matches/${encodeURIComponent(mid)}/cases`);
 if(!Array.isArray(response.cases))throw Error('판독 상태를 확인할 수 없습니다.');
 const cases=response.cases.filter(c=>typeof c.id==='string'&&/^[a-z0-9-]+$/.test(c.id));
 const results=await Promise.allSettled(cases.map(c=>api(`/api/courtside/matches/${encodeURIComponent(mid)}/cases/${encodeURIComponent(c.id)}/bridge/api/cases/${encodeURIComponent(c.id)}/reports`)));
 return reportCompletion(cases,results);
}
async function firstRecording(mid){
 return fetchFirstRecording(mid,
  id=>fetch(`/api/recordings/matches/${encodeURIComponent(id)}/courtside-first-frame`),
  id=>api(`/api/courtside/matches/${encodeURIComponent(id)}/recording-parts`));
}
async function cardDetails(mid){
 const [recording,report]=await Promise.allSettled([firstRecording(mid),reportStatus(mid)]);
 return {first:recording.status==='fulfilled'?recording.value:null,report:report.status==='fulfilled'?report.value:'unknown'};
}
function firstFrame(thumb,mid,first){
 if(!first)return;
 const url=recordingPreviewUrl(location.origin,mid,first.sessionId,first.partNumber);if(!url)return;
 const fallback=thumb.querySelector('.match-monogram'),video=node('video','match-first-frame');
 video.muted=true;video.playsInline=true;video.preload='metadata';video.tabIndex=-1;video.setAttribute('aria-hidden','true');video.hidden=true;
 video.onloadedmetadata=()=>{try{video.currentTime=0;}catch{}};
 video.onloadeddata=()=>{if(!thumb.isConnected)return;video.hidden=false;fallback.hidden=true;};
 video.onerror=()=>{video.remove();fallback.hidden=false;};thumb.prepend(video);video.src=url;video.load();
}
function hydrate(row,match){
 let task=details.get(match.id);
 if(!task){task=limited(()=>cardDetails(match.id));details.set(match.id,task);}
 task.then(value=>{
  if(!row.isConnected)return;
  const label={complete:'리포트 작업 완료', 'in-progress':'리포트 작업 중', 'not-started':'리포트 작업 전',unknown:'리포트 상태 확인 불가'}[value.report]||'리포트 상태 확인 불가';
  const badge=row.querySelector('.match-report-status');badge.textContent=label;badge.dataset.status=value.report;row.setAttribute('aria-label',`${match.name} · ${label} · 경기 상세 열기`);
  firstFrame(row.querySelector('.match-thumbnail'),match.id,value.first);
 }).catch(()=>{if(row.isConnected){const badge=row.querySelector('.match-report-status');badge.textContent='리포트 상태 확인 불가';badge.dataset.status='unknown';}});
}
function render(){
 $('matchCount').textContent=String(total);$('emptyMatches').hidden=total>0;observer?.disconnect();
 observer='IntersectionObserver' in window?new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){observer.unobserve(entry.target);const match=matches.find(m=>m.id===entry.target.dataset.matchId);if(match)hydrate(entry.target,match);}},{rootMargin:'250px'}):null;
 $('matchList').replaceChildren(...matches.map(m=>{
  const link=node('a','match-row');link.href=`./fpc-match.html?id=${encodeURIComponent(m.id)}`;link.dataset.matchId=m.id;link.setAttribute('aria-label',`${m.name} · 경기 상세 열기`);
  const thumb=node('div','match-thumbnail');thumb.append(node('span','match-monogram','KBL'),node('span','match-city',m.archived?'보관된 경기':'FPC 경기'));
  const info=node('div','match-info');info.append(node('div','match-date',`${dateText(m)} · KBL`),node('h2','',m.name),node('p','match-referees','경기 상세에서 영상·CSV를 등록하세요.'));
  const action=node('div','match-action');action.append(node('span','match-report-status','리포트 상태 확인 중'),node('span','match-open','경기 열기 →'));
  link.append(thumb,info,action);if(observer)observer.observe(link);else hydrate(link,m);return link;
 }));stats();renderPagination();
}
function renderPagination(){
 const nav=$('matchPagination'),pages=Math.max(1,Math.ceil(total/PAGE_SIZE));nav.replaceChildren();nav.hidden=pages<=1;if(nav.hidden)return;
 const button=(label,target,disabled=false)=>{const b=node('button','',label);b.type='button';b.disabled=disabled;b.onclick=()=>load(target,true);return b;};
 nav.append(button('← 이전',page-1,page===1));
 const first=Math.floor((page-1)/5)*5+1;
 for(let n=first;n<=Math.min(first+4,pages);n++){const b=button(String(n),n);if(n===page){b.className='is-current';b.setAttribute('aria-current','page');}nav.append(b);}
 nav.append(button('다음 →',page+1,page===pages));
}
async function load(nextPage=1,scroll=false){
 const token=++requestId,q=$('matchSearch').value.trim();page=nextPage;observer?.disconnect();matches=[];$('matchList').replaceChildren();$('matchPagination').hidden=true;$('emptyMatches').hidden=true;$('catalogState').hidden=false;$('catalogState').textContent=q?'경기를 검색하는 중입니다.':'경기 목록을 불러오는 중입니다.';
 const params=new URLSearchParams({sport:'BASKETBALL',limit:String(PAGE_SIZE),offset:String((page-1)*PAGE_SIZE),compact:'true'});if(q)params.set('q',q);
 try{const result=await api(`/api/matches/page?${params}`);if(token!==requestId)return;
  if(!Array.isArray(result.items))throw Error('경기 목록을 확인하지 못했습니다.');
  matches=result.items.filter(m=>uuid(m.id)&&typeof m.name==='string');total=Number.isInteger(result.total)?result.total:matches.length;
  const last=Math.max(1,Math.ceil(total/PAGE_SIZE));if(page>last)return load(last,scroll);
  $('catalogState').hidden=true;render();if(scroll)$('catalogToolbar').scrollIntoView({block:'start',behavior:'smooth'});
 }catch(e){if(token===requestId)$('catalogState').textContent=`경기 목록을 불러오지 못했습니다. ${e.message}`;}
}
$('matchSearch').oninput=()=>{requestId++;clearTimeout(searchTimer);searchTimer=setTimeout(()=>load(1),250);};
$('clearSearch').onclick=()=>{clearTimeout(searchTimer);$('matchSearch').value='';load(1);$('matchSearch').focus();};load();
