// Geometry transcribed from FIBA Official Basketball Rules 2024, Art. 2 / diagrams 1–4.
// A shared vector asset, not a photograph or a surveyed SK arena floor.
export const COURT={length:28,width:15,basketX:1.575,threeRadius:6.75,cornerY:.9};
export const cornerJoinX=COURT.basketX+Math.sqrt(COURT.threeRadius**2-(7.5-COURT.cornerY)**2);
export const courtSource='https://assets.fiba.basketball/image/upload/documents-corporate-fiba-official-rules-2024-v10a.pdf';
let asset=null,linesAsset=null,loading;
export function loadCourtAsset(){
 if(!loading)loading=Promise.all(['fiba-28x15.svg','fiba-28x15-lines.svg'].map(name=>new Promise((resolve,reject)=>{const im=new Image();im.onload=()=>resolve(im);im.onerror=()=>reject(Error('코트 에셋을 불러오지 못했습니다.'));im.src=new URL('./assets/court/'+name,import.meta.url).href;}))).then(([full,lines])=>{asset=full;linesAsset=lines;return full;});
 return loading;
}
export function courtLines(ctx,w,h,pad=0,linesOnly=false){
 if(asset){ctx.drawImage(linesOnly?linesAsset:asset,pad,pad,w-pad*2,h-pad*2);return;}
 // Used only while older pages asynchronously load the same asset.
 const sx=(w-pad*2)/28,sy=(h-pad*2)/15;ctx.save();ctx.translate(pad,pad);ctx.scale(sx,sy);ctx.strokeStyle='#fff5de';ctx.lineWidth=.05;ctx.strokeRect(0,0,28,15);
 ctx.beginPath();ctx.moveTo(14,0);ctx.lineTo(14,15);ctx.stroke();
 for(const right of [false,true]){ctx.save();if(right){ctx.translate(28,15);ctx.rotate(Math.PI);}ctx.strokeRect(0,5.05,5.8,4.9);ctx.beginPath();ctx.moveTo(0,.9);ctx.lineTo(cornerJoinX,.9);ctx.arc(1.575,7.5,6.75,-Math.asin(6.6/6.75),Math.asin(6.6/6.75));ctx.lineTo(0,14.1);ctx.stroke();ctx.restore();}ctx.restore();
}
