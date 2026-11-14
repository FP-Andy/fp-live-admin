// A wide-view placement is a draft, never an edit to an existing scene entity.
export function createWidePositionMode(validPosition) {
 let callback=null, point=null;
 return {
  begin(next){if(typeof next!=='function')throw Error('위치 선택을 시작할 수 없습니다.');callback=next;point=null;},
  choose(next){if(!callback)return false;if(!validPosition(next))throw Error('코트 주변 표시 영역 안에서 선택하세요.');point={x:next.x,y:next.y};callback({...point});return true;},
  cancel(){callback=null;point=null;},
  get active(){return !!callback;},
  get preview(){return point?{...point}:null;},
 };
}
