import {clone,importEvents,identityAt} from './core.mjs';

export const eventId=event=>event?.row.FpaEventId||null;
export function fpaDocument(review) {
  return {...clone(review.fpa?.metadata||{}),sport:'FUTSAL',rows:review.events.map(e=>clone(e.row)),logs:review.events.map(e=>e.log)};
}

// Index is a legacy review detail; durable linkage follows the event UUID.
export function withDocument(review,document,{imported=false,action='edit'}={}) {
  const events=document.rows.length?importEvents(document):[];
  const byId=new Map(review.events.map(e=>[eventId(e),e]));
  const ids=new Set(),links={};
  for(const event of events) {
    const id=eventId(event);
    if(!id||ids.has(id))throw Error('FPA 이벤트 ID가 누락되거나 중복되었습니다.');ids.add(id);
    const previous=byId.get(id);
    if(!imported&&previous)for(const role of ['actor','receiver']) {
      const field=role==='actor'?'Player':'Receiver',link=review.links[previous.index]?.[role];
      if(link&&previous.half===event.half&&['Team','Time','Action','Tags',field].every(k=>String(previous.row[k]??'')===String(event.row[k]??'')))
        (links[event.index]??={})[role]=clone(link);
    }
  }
  const {rows,logs,...metadata}=document;
  const before=review.events.filter(old=>{
    const current=events.find(e=>eventId(e)===eventId(old));
    return !current||JSON.stringify(current.row)!==JSON.stringify(old.row)||current.log!==old.log;
  });
  const record={time:new Date().toISOString(),action,before:before.map(e=>({row:clone(e.row),log:e.log})),eventIds:events.filter(e=>!byId.has(eventId(e))||before.some(b=>eventId(b)===eventId(e))).map(eventId)};
  return {...review,events,links,fpa:{metadata,source:imported?clone(document):review.fpa?.source||null,
    history:[...(review.fpa?.history||[]),record].slice(-30)}};
}

export function matchableIdentity(working,trackId,time,event,role) {
  const identity=identityAt(working,trackId,time);
  if(!identity||!['home','away'].includes(identity.team)||!/^\d{1,3}$/.test(identity.jersey))throw Error('번호가 지정된 홈/원정 선수 BB를 선택하세요. 심판·미확정 객체는 연결할 수 없습니다.');
  if(event&&event.row.Team!==identity.team)throw Error('데이터 행과 선수의 팀이 다릅니다. 팀을 확인하세요.');
  if(event&&role==='receiver'&&!event.row.Receiver)throw Error('이 행에는 수신자가 없습니다.');
  return identity;
}

export function linkStatus(review,working,event,role) {
  const link=review.links[event.index]?.[role];if(!link)return 'none';
  if(!working)return 'none';
  const identity=identityAt(working,link.trackId,link.time),number=role==='actor'?event.row.Player:event.row.Receiver;
  return identity?.team===event.row.Team&&identity?.jersey===String(number)?'linked':'stale';
}

export function splitCode(value) {
  const [base,...tags]=value.toLowerCase().trim().split('.');
  if(/^\d+$/.test(base))return {actor:base,action:'touch',receiver:'',tags};
  const m=base.match(/^(\d*)([a-z]+)(\d*)$/);
  return m?{actor:m[1],action:m[2],receiver:m[3],tags}:null;
}
export const joinCode=p=>`${p.actor}${p.action}${p.receiver}${p.tags.length?'.'+p.tags.join('.'):''}`;
export function numberInCode(code,role,jersey) {
  const parsed=splitCode(code)||{actor:'',action:'touch',receiver:'',tags:[]};
  parsed[role]=jersey;return joinCode(parsed);
}
export function videoTimeline(sourceTime,offset=0) {
  const value=sourceTime-offset;
  if(!Number.isFinite(value)||value<0)throw Error('영상 시각이 이 피리어드의 시작보다 앞입니다. 오프셋을 확인하세요.');
  const ms=Math.round(value*1000),minutes=Math.floor(ms/60000),seconds=(ms%60000)/1000;
  return `${String(minutes).padStart(2,'0')}:${seconds.toFixed(3).padStart(6,'0')}`;
}
