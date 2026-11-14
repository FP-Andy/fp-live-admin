// One target for the map, eye cameras and occlusion rays. A free point is not a person.
export function reviewPoint(x,y){
 if(!Number.isFinite(x)||!Number.isFinite(y)||x< -2||x>30||y< -2||y>17)throw Error('별표 위치는 코트와 주변 2m 안에서 지정하세요.');
 return {x,y,source:'manual-map'};
}
export function reviewTarget(state,bodies){
 if(state.reviewPoint)return {...reviewPoint(state.reviewPoint.x,state.reviewPoint.y),z:state.targetHeight};
 const person=bodies.find(e=>e.id===state.targetId);
 if(!person)throw Error('판독 대상 후보가 필요합니다.');
 return {x:person.x,y:person.y,z:state.targetHeight,entityId:person.id};
}
