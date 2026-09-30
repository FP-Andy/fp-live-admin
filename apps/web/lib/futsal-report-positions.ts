// Paired report labels: role categories for readers, not an exact tactical equivalence.
export const REPORT_ROLES=[
 {value:'GK',football:'GK · 골키퍼',futsal:'GOLEIRO · 골레이로',short:'GK · GOLEIRO',focus:'골문과 동료 사이의 연결',next:'공이 이동할 때 골문과 동료를 함께 보고, 공을 잡은 뒤 연결할 통로를 준비해 봐요.'},
 {value:'DF',football:'DF · 수비수',futsal:'FIXO · 픽소',short:'DF · FIXO',focus:'뒤쪽 공간을 지키며 앞선과 잇는 연결',next:'전진한 뒤에는 뒤쪽 공간과 동료 간격을 함께 살펴봐요. 다음 수비와 연결을 같이 준비할 수 있어요.'},
 {value:'MF',football:'MF · 미드필더',futsal:'ALA · 알라',short:'MF · ALA',focus:'중앙과 측면을 오가며 동료를 잇는 연결',next:'공을 연결한 뒤 옆 공간이나 반대편을 한 번 더 살펴봐요. 동료가 다시 연결할 선택지가 늘어날 거예요.'},
 {value:'FW',football:'FW · 공격수',futsal:'PIVO · 피보',short:'FW · PIVO',focus:'전방에서 공을 받고 마무리를 준비하는 움직임',next:'공을 받기 전 골문과 동료의 위치를 함께 살펴봐요. 직접 마무리할 때와 연결할 때의 선택을 준비해 봐요.'},
] as const;
export function reportRole(position:string){return REPORT_ROLES.find(r=>r.value===position||r.short.split(' · ')[1]===position);}

export function roleActivity(position:string,zone:number,broad:boolean){
 const role=reportRole(position);if(!role)return '';
 const detail={
  GK:'골문을 기준으로 동료 뒤를 지원할 위치가 중요해요. 공이 반대편으로 이동할 때도 연결할 각도를 준비하는 관점으로 읽어봐요.',
  DF:zone===2?'수비 역할이지만 활동 무대는 전방에 가까웠어요. 공격에 올라간 뒤 골문 쪽으로 돌아올 공간과 동료 뒤의 간격을 함께 살펴볼 만해요.':'수비에서는 공을 향해 나가는 움직임과 골문 쪽 공간을 지키는 균형이 중요해요. 자주 머문 위치를 기준으로 동료 뒤를 지원하고, 공을 되찾은 뒤 첫 연결을 준비하는 관점으로 읽어봐요.',
  MF:broad?'전후방에 걸쳐 활동한 발자취가 남았어요. 미드필더의 활동 폭과 기회 창출을 볼 때는 이동한 구역 사이에서 공을 받을 각도와 동료에게 열어 줄 통로를 함께 살펴보면 좋아요.':'미드필더에게는 공을 받을 각도와 다음 연결을 준비하는 위치가 중요해요. 활동이 모인 공간에서 옆으로 한 걸음 움직이거나 전방을 바라보는 선택이 기회를 여는 출발점이 될 수 있어요.',
  FW:zone===0?'공격 역할 가운데 앞쪽에 있었지만, 활동은 우리 진영 가까이 모였어요. 공을 받으러 내려온 뒤 공격 방향으로 다시 올라가는 움직임과 골문 앞에 도착하는 시점을 함께 돌아봐요.':'공격수는 골문을 향한 방향과 슈팅할 공간을 함께 준비하는 역할이에요. 자주 찾은 위치에서 공을 받기 전 몸을 열고, 마무리할 자리로 들어가는 타이밍을 눈여겨봐요.',
 }[role.value];
 return `${role.short} 관점으로 보면, ${detail}`;
}
export function rolePlay(position:string,shots:number,goals:number,recoveries:number,defense:number){
 const role=reportRole(position);if(!role)return '';
 const detail={
  GK:'골문 앞 기록과 동료의 위치를 함께 보며 수비 뒤 첫 연결을 준비해 봐요. 가까운 지원 위치를 찾는 것도 좋은 출발이에요.',
  DF:recoveries||defense?'직접 남긴 수비 기록을 바탕으로, 공을 향해 나간 뒤 골문 쪽 공간과 동료 간격을 어떻게 정리했는지 돌아봐요. 수비 뒤 첫 연결까지 준비하면 다음 플레이가 더 편해질 거예요.':'상대가 슈팅한 위치와 내 활동 구역 사이에서 수비할 공간을 살펴봐요. 공 쪽으로 나갈 때 동료 뒤의 빈 곳을 함께 확인하는 습관을 더해 보면 좋아요.',
  MF:shots?'직접 슈팅한 장면은 연결 역할에서 마무리까지 나선 기록이에요. 공을 받을 때 전방과 옆 공간을 함께 보고, 동료에게 연결할지 직접 시도할지 선택을 넓혀 봐요.':'기회 창출은 동료가 공을 받을 수 있는 각도를 준비하는 데서 시작할 수 있어요. 팀 슈팅이 나온 통로와 활동 구역을 비교하며, 연결 뒤 다시 지원할 위치를 찾아봐요.',
  FW:goals?'득점으로 이어진 마무리가 확인돼요. 그 장면에서 공을 받기 전의 위치와 슈팅 방향을 기억해 두고, 비슷한 공간을 다시 찾는 움직임을 이어 가 봐요.':shots?'슈팅으로 마무리를 시도한 기록이 있어요. 공격 방향으로 몸을 열고 골문을 바라본 순간을 돌아보며, 다음에는 슈팅할 공간에 조금 더 여유 있게 도착해 봐요.':'팀의 슈팅 위치를 참고해 골문 가까이에서 공을 받을 자리를 찾아봐요. 직접 연결된 슈팅 기록은 아직 없지만, 공격 방향으로 한 걸음 먼저 준비하는 움직임을 시도해 볼 수 있어요.',
 }[role.value];
 return `${role.short} 역할에서는 ${detail}`;
}

type ReviewEvidence={position:string;zone:number;side:number;broad:boolean;shots:number;goals:number;recoveries:number;defense:number;phaseChange?:'forward'|'back'|'side'|'steady';firstPhase?:string;lastPhase?:string;distinctZone?:boolean;distinctSide?:boolean};
// Each slot has a different evidence source. No random paraphrases or invented
// assists, distance, defensive success, or shot attribution from team-only data.
export function roleReview(e:ReviewEvidence){
 const role=reportRole(e.position);if(!role)return null;
 const area=e.distinctZone===false?'코트의 여러 구역':['우리 진영 가까운 공간','코트 가운데','상대 진영 가까운 공간'][e.zone],lane=e.distinctSide===false?'여러 통로':['왼쪽 측면','중앙 통로','오른쪽 측면'][e.side];
 const strength={
  GK:`골문을 지키는 역할에서 ${area}에 활동이 남았어요. 동료와 이어질 위치를 돌아볼 수 있는 단서예요.`,
  DF:e.zone===0&&e.distinctZone!==false?'우리 진영 가까이에 활동이 모였어요. 후방을 기준으로 수비 역할을 읽어 볼 수 있는 발자취가 남았어요.':`${area}까지 활동한 수비 역할이었어요. 뒤쪽뿐 아니라 앞선에서 선택한 위치도 함께 눈여겨볼 만해요.`,
  MF:e.broad?'전방과 후방 모두에 활동이 남았어요. 여러 구역을 오간 움직임은 연결 역할을 돌아볼 좋은 바탕이에요.':`${area}에 미드필더의 활동이 모였어요. 자주 찾은 공간을 바탕으로 다음 연결 위치를 준비해 볼 수 있어요.`,
  FW:e.zone===2&&e.distinctZone!==false?'상대 진영 가까이에서 활동한 흔적이 뚜렷해요. 골문을 향해 준비한 위치를 다음 공격에도 살려 봐요.':`${area}에서 공격 역할의 발자취가 남았어요. 전방으로 나가기 전 공을 받을 위치를 살펴볼 만해요.`,
 }[role.value];
 const action=e.goals?'득점으로 공격을 마무리한 기록이 남았어요. 골문을 향한 그 시도를 다음 기회의 자신감으로 이어 가 봐요.':e.recoveries?'공을 되찾는 플레이에 직접 참여했어요. 상대의 소유를 끊고 우리 팀이 다시 시작할 순간을 만들었어요.':e.defense?'수비에 참여한 장면이 기록됐어요. 공을 향해 움직인 그 선택과 이후 위치를 함께 돌아봐요.':e.shots?'직접 슈팅을 시도한 장면이 남았어요. 골문을 향해 마무리한 경험을 다음 기회의 바탕으로 삼아 봐요.':`${lane}에 움직임이 남았어요. 익숙한 통로에서 다음 플레이를 준비할 위치를 찾아볼 수 있어요.`;
 const change=e.phaseChange==='forward'?`${e.lastPhase}에는 평균 위치가 더 전방으로 이동했어요. 공격 쪽으로 활동 무대가 달라진 점을 눈여겨봐요.`:e.phaseChange==='back'?`${e.lastPhase}에는 평균 위치가 우리 진영 쪽으로 옮겨 갔어요. 경기 흐름에 따라 달라진 활동 위치가 남았어요.`:e.phaseChange==='side'?`${e.lastPhase}에는 주로 찾는 측면이 달라졌어요. 같은 공간에만 머무르지 않은 활동 분포를 살펴볼 수 있어요.`:e.shots&&(e.recoveries||e.defense)?'수비 기록과 슈팅이 모두 남았어요. 공을 되찾거나 막아 낸 위치와 마무리에 나선 위치를 함께 돌아봐요.':e.phaseChange==='steady'?`${e.firstPhase||'초반'}과 ${e.lastPhase||'후반'}의 평균 위치가 비슷하게 이어졌어요. 자주 활동한 구역을 이번 경기의 기준점으로 삼아봐요.`:`이번 경기에는 ${area}와 ${lane}가 활동을 이해하는 단서예요. 내게 익숙한 공간부터 살펴봐요.`;
 const first={GK:REPORT_ROLES[0].next,DF:e.zone===2?'공격에 올라간 뒤 돌아올 위치를 먼저 살펴봐요. 뒤에 남은 동료와 골문 사이의 빈 곳을 함께 확인해 보세요.':'공을 향해 나가기 전, 뒤쪽 공간과 동료의 간격을 확인해 봐요. 상대가 안쪽으로 들어올 길을 함께 살펴보세요.',MF:e.broad?'구역을 옮겨 다닐 때 공을 가진 동료가 나를 볼 수 있는 각도를 만들어 봐요. 이동의 폭을 연결할 선택지로 바꿔 보세요.':'공을 연결한 뒤 같은 자리에 머무르기보다 옆으로 한 걸음 더 움직여 봐요. 동료가 다시 공을 줄 통로를 준비해 보세요.',FW:e.zone===0?'공을 받으러 내려온 뒤에는 골문 쪽으로 다시 움직일 타이밍을 찾아봐요. 공격 방향으로 돌아설 준비를 해보세요.':'공이 오기 전에 골문과 수비수 위치를 함께 살펴봐요. 슈팅할 공간을 먼저 찾으면 마무리 선택이 한결 편해질 거예요.'}[role.value];
 const second=e.recoveries||e.defense?'수비한 뒤 가까운 동료에게 연결할 길을 먼저 찾아봐요. 공을 되찾는 순간 다음 선택도 준비할 수 있어요.':e.shots?'슈팅한 장면에서 몸의 방향과 동료의 지원 위치를 함께 돌아봐요. 직접 마무리할 때와 연결할 때를 비교해 보세요.':role.value==='DF'?`${lane}에서 상대를 볼 때 골문 쪽 공간도 함께 확인해 봐요. 공과 공간을 번갈아 살피는 습관을 더해 보세요.`:role.value==='MF'?`${lane}를 지나갈 때 반대편 동료도 한 번 살펴봐요. 가까운 연결과 먼 연결을 함께 준비해 보세요.`:`${lane}에서 공을 기다릴 때 수비수와 같은 선을 벗어나 봐요. 짧은 방향 전환으로 받을 자리를 준비해 보세요.`;
 const third=e.phaseChange==='forward'?'위치가 전방으로 바뀐 구간에서 플레이 뒤 복귀 위치를 돌아봐요. 공격과 다음 수비를 함께 준비해 보세요.':e.phaseChange==='back'?'우리 진영 쪽으로 이동한 구간에서 전방을 볼 여유도 찾아봐요. 공을 잡은 뒤 다시 나아갈 선택지를 준비해 보세요.':e.phaseChange==='side'?'주 활동 측면이 바뀐 구간의 첫 터치 방향을 돌아봐요. 익숙하지 않은 쪽에서도 전방을 볼 준비를 해보세요.':role.value==='FW'?'한 번의 슈팅 뒤에도 플레이를 이어 가 봐요. 골문 앞에서 흘러나오는 공을 만날 다음 위치를 살펴보세요.':role.value==='MF'?'팀이 슈팅한 뒤에도 지원할 위치를 찾아봐요. 공격이 이어질 공간과 수비로 돌아설 길을 함께 준비해 보세요.':'우리 팀이 공격할 때도 뒤에 남은 공간을 한 번 살펴봐요. 공이 넘어왔을 때 대응할 자리를 준비해 보세요.';
 return {strengths:[strength,action,change],improvements:[first,second,third]};
}
