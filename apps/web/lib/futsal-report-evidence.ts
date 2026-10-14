import type {HeatPlayer} from './futsal-report';

/** Observation volume, not the time between entry and the last linked frame.
 * Estimated density is deliberately excluded from narrative eligibility. */
export function observedSeconds(player:HeatPlayer|undefined,from=-Infinity,to=Infinity){
 return (player?.positions||[]).reduce((n,q)=>n+Math.max(0,Math.min(to,q.t+q.seconds)-Math.max(from,q.t)),0);
}
export function limitedObservationStory(seconds:number){
 return {
  heatComment:seconds>0
   ? '히트맵에는 현재 확인된 장면 속 위치를 담았어요. 연결된 움직임이 제한적이어서 경기 전체의 활동량이나 주된 역할을 평가하기에는 근거가 충분하지 않아요.\n\n표시된 위치에서 동료와 어떤 간격을 만들었는지, 다음 플레이를 위해 어디로 움직였는지 영상을 함께 돌아보면 좋아요. 추적 기록의 길이는 실제 출전시간과 다를 수 있어요.'
   : '현재는 이 선수로 연결이 확인된 움직임이 없어 히트맵을 해석하기 어려워요. 실제 출전 여부나 활동량을 뜻하는 것은 아니에요. 연결을 확인한 뒤 움직임을 함께 돌아봐 주세요.',
  eventComment:'이벤트맵은 양 팀의 경기 흐름을 보여줘요. 팀의 슈팅 위치를 이 선수의 직접적인 기여로 해석하지는 않았어요. 개인으로 연결된 이벤트가 있다면 그 장면부터 살펴보고, 주변에서 어떤 위치를 준비했는지 영상과 함께 돌아봐 주세요.',
  strengths:['확인된 장면을 바탕으로 좋은 시도를 찾아볼 수 있어요.','동료와 연결을 준비한 순간이 있었는지 함께 살펴봐요.','개인의 장점을 단정하기보다 직접 확인한 플레이를 출발점으로 삼아 주세요.'],
  improvements:['공이 움직일 때 동료와 유지한 간격을 영상에서 확인해 보세요.','플레이를 마친 뒤 다음 연결을 위해 선택한 위치를 돌아보세요.','추가 장면이 연결되면 움직임의 특징을 더 구체적으로 살펴볼 수 있어요.'],
 };
}
