export function validateLineup(value){
  if(value?.schema!=='fpa-lineup/v1'||typeof value.matchId!=='string'||!value.matchId||!Array.isArray(value.players)||value.players.length>100)throw Error('경기 명단 JSON 형식이 올바르지 않습니다.');
  const keys=new Set();
  for(const p of value.players){
    if(!['home','away'].includes(p.team)||!/^\d{1,3}$/.test(p.jersey)||typeof p.name!=='string'||!p.name||p.name.length>80||!['','GK','DF','MF','FW'].includes(p.position||'')||!['starter','appeared','unknown'].includes(p.status))throw Error('명단의 팀·등번호·이름·포지션·출전 구분을 확인하세요.');
    const key=`${p.team}:${Number(p.jersey)}`;if(keys.has(key))throw Error('같은 팀에 같은 등번호가 중복되었습니다.');keys.add(key);
  }
  return structuredClone(value);
}

// Slot IDs stay stable: existing BB anchors are never reassigned by list order,
// nominal position, or a coincidentally matching placeholder jersey number.
export function bindLineup(roster,lineup,choices){
  lineup=validateLineup(lineup);const used=new Set();
  return roster.map(p=>{
    if(p.group==='referee')return {...p};
    const team=p.group.startsWith('home')?'home':'away',number=choices[p.id];
    const player=lineup.players.find(a=>a.team===team&&a.jersey===number);
    if(!player)throw Error('현재 코트의 12명 모두 명단에서 선택하세요.');
    const externalId=`${lineup.matchId}:${team}:${player.jersey}`;
    if(used.has(externalId))throw Error('한 선수를 두 슬롯에 연결할 수 없습니다.');used.add(externalId);
    return {...p,jersey:player.jersey,name:player.name,position:player.position||'',externalId,club:lineup.teams?.[team]||team};
  });
}

export function lineupUI({holder,getReview,commit,message}){
  const node=(tag,text)=>{const n=document.createElement(tag);if(text)n.textContent=text;return n;};
  const input=node('input');input.type='file';input.accept='.json';input.hidden=true;
  const load=node('label','출전 명단 JSON 열기');load.className='button';load.append(input);
  const title=node('p'),grid=node('div'),save=node('button','명단 연결 저장'),source=node('a','기록지 원본 ↗');
  grid.className='lineup-grid';save.type='button';save.className='primary';source.target='_blank';source.rel='noopener';
  holder.append(load,title,source,grid,save);let signature='',choices={};
  input.onchange=async()=>{try{const file=input.files[0];input.value='';if(!file)return;if(file.size>1024*1024)throw Error('명단은 1MB 이하 JSON으로 열어 주세요.');const lineup=validateLineup(JSON.parse(await file.text()));commit({...getReview(),lineup});message('명단을 열었습니다. 기존 영상의 12명과 명단 선수를 연결하세요.');}catch(e){message(e.message,true);}};
  function render(){
    const review=getReview(),lineup=review?.lineup;
    if(!review){input.disabled=true;return;}input.disabled=false;
    const key=JSON.stringify([lineup,review.roster]);if(key===signature)return;signature=key;
    grid.replaceChildren();source.hidden=save.hidden=!lineup;
    if(!lineup){title.textContent='기록지의 등번호·이름·포지션을 영상 선수와 연결합니다.';return;}
    title.textContent=`${lineup.matchId} · ${lineup.teams?.home||'홈'} – ${lineup.teams?.away||'원정'} · 선발 외 출전 ${lineup.players.filter(p=>p.status==='appeared').length}명. ${(lineup.notes||[]).join(' ')}`;
    const url=lineup.source?.url;source.hidden=!url||!/^https:\/\//.test(url);if(!source.hidden)source.href=url;
    choices={};
    for(const team of ['home','away']){
      const section=node('div'),heading=node('h3',`${team==='home'?'홈':'원정'} · ${lineup.teams?.[team]||''}`);section.append(heading);
      for(const p of review.roster.filter(p=>p.group.startsWith(team))){
        const row=node('label',`${p.group.endsWith('_gk')?'키퍼':'필드'} · 현재 ${p.jersey||'미지정'}`),select=node('select');select.setAttribute('aria-label',`${p.id} 출전 선수`);select.append(new Option('명단 선수 선택',''));
        for(const a of lineup.players.filter(a=>a.team===team).sort((a,b)=>(a.status==='starter'?0:1)-(b.status==='starter'?0:1))){select.append(new Option(`${a.jersey} ${a.name} · ${a.position||'포지션 미상'} · ${a.status==='starter'?'선발':a.status==='appeared'?'추가 출전':'출전 미확인'}`,a.jersey));}
        if(p.externalId===`${lineup.matchId}:${team}:${p.jersey}`)choices[p.id]=select.value=p.jersey;
        select.onchange=()=>choices[p.id]=select.value;row.append(select);section.append(row);
      }
      grid.append(section);
    }
  }
  save.onclick=()=>{try{const review=getReview(),roster=bindLineup(review.roster,review.lineup,choices);commit({...review,roster});message('명단 연결 저장 · 검수 반영을 누르면 재연결에 사용합니다.');}catch(e){message(e.message,true);}};
  return {render};
}
