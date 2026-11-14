import {POSITION_LIMITS} from './ground-position.mjs';
import {mapCourt,mapPoint,pickMap} from './scene-map.mjs';

// Selection is a click; only a deliberate screen-space movement edits geometry.
export const DRAG_THRESHOLD_PX=5;
export function dragStarted(drag,pointer){
 return drag.moved||Math.hypot(pointer.clientX-drag.startClient[0],pointer.clientY-drag.startClient[1])>=DRAG_THRESHOLD_PX;
}
export function positionDragPoint(drag,pixel){
 const point=mapCourt(pixel);
 return Object.fromEntries(['x','y'].map(key=>[key,Math.max(POSITION_LIMITS[key][0],Math.min(POSITION_LIMITS[key][1],point[key]+drag.offset[key]))]));
}
export function positionTargets(bodies,pixel,scale,selectedId){
 const nearest=pickMap(bodies,pixel,scale);if(!nearest)return null;
 const distance=body=>Math.hypot(...mapPoint(body).map((v,i)=>(v-pixel[i])*scale));
 const selected=bodies.find(body=>body.id===selectedId);
 // Repeated clicks can cycle overlapping people. Dragging retains the selected
 // person in that same hit cluster rather than moving a hidden neighbour.
 const drag=selected&&distance(selected)<14&&distance(selected)<distance(nearest)+7?selected:nearest;
 return {dragId:drag.id,clickId:pickMap(bodies,pixel,scale,selectedId).id};
}
export function placementTarget(boxes,id){
 return boxes.some(b=>b.id===id&&['player','referee'].includes(b.roleHint))?id:'';
}
