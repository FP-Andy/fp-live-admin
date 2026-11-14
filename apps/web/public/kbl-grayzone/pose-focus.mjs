// A stable crop for editing one person's joints. Coordinates stay in the source
// image so both editors share the same edits, history and downstream pose job.
export function focusCrop(person, imageWidth=1920, imageHeight=1080, aspect=2/3) {
  const box=person?.pixelBox;
  if(!box||box.length!==4||!box.every(Number.isFinite))return null;
  let [left,top,right,bottom]=box;
  for(let i=5;i<(person.keypoints?.length||0);i++){
    const q=person.keypoints[i];
    if(!q?.every(Number.isFinite)||!(person.scores?.[i]>=.3||person.manualJoints?.[i]))continue;
    if(q[0]<0||q[0]>imageWidth||q[1]<0||q[1]>imageHeight)continue;
    left=Math.min(left,q[0]);right=Math.max(right,q[0]);top=Math.min(top,q[1]);bottom=Math.max(bottom,q[1]);
  }
  const pad=Math.max(16,(bottom-top)*.12);
  let width=Math.max(90,right-left+pad*2),height=Math.max(120,bottom-top+pad*2);
  width=Math.max(width,height*aspect);height=width/aspect;
  const scale=Math.min(1,imageWidth/width,imageHeight/height);width*=scale;height*=scale;
  return {x:Math.max(0,Math.min(imageWidth-width,(left+right-width)/2)),y:Math.max(0,Math.min(imageHeight-height,(top+bottom-height)/2)),width,height};
}
export function focusToImage(point,crop,width,height){
  return [crop.x+point[0]/width*crop.width,crop.y+point[1]/height*crop.height];
}
export function imageToFocus(point,crop,width,height){
  return [(point[0]-crop.x)/crop.width*width,(point[1]-crop.y)/crop.height*height];
}
