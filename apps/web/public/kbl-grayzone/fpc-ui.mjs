export const $=id=>document.getElementById(id);
export const uuid=value=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value||'');
export const intakeId=value=>/^[a-f0-9]{24}$/.test(value||'');
export const node=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;};
export async function api(url,options){
 const response=await fetch(url,options);
 if(response.status===401){location.replace('/login?next='+encodeURIComponent('/admin/basketball/courtside'));throw Error('로그인이 필요합니다.');}
 let data;try{data=await response.json();}catch{throw Error('서버 응답을 확인하지 못했습니다.');}
 if(!response.ok)throw Error(typeof data.detail==='string'?data.detail:typeof data.error==='string'?data.error:'요청을 처리하지 못했습니다.');
 return data;
}
export function dateText(m){
 const value=['match_date','game_date','scheduled_at','kickoff_at','date'].map(k=>m.metadata?.[k]).find(x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}/.test(x));
 if(!value)return '경기일 미확인';
 if(/[T ]\d{2}:\d{2}.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)){
  const date=new Date(value);
  if(!Number.isNaN(date.getTime())){
   const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
   const get=type=>parts.find(p=>p.type===type)?.value;
   return `${get('year')}.${get('month')}.${get('day')}`;
  }
 }
 return value.slice(0,10).replaceAll('-','.');
}
export const bridge=(match,id,kind='intakes')=>`/api/courtside/matches/${encodeURIComponent(match)}/${kind}/${encodeURIComponent(id)}/bridge/workflow.html?${kind==='cases'?'case':'intake'}=${encodeURIComponent(id)}`;
