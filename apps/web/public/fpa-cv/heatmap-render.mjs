export const HEATMAP_EXPORT_SIZE=Object.freeze({width:1320,height:720});
export const QUEENS_CUP_COLORS=Object.freeze({pitch:'#FFFFFF',line:'#E162A7',surround:'#EFCADE'});

// Shared density remains comparable across players. Colour/opacity alone
// emphasise concentrated activity: cool faint edges, yellow, orange, red core.
export function densityColor(value){
  if(!Number.isFinite(value)||value<.015)return [0,0,0,0];
  const t=Math.sqrt(Math.min(1,value));
  const stops=[[0,[65,182,238]],[.28,[45,190,219]],[.45,[255,226,55]],[.62,[255,116,0]],[.76,[247,38,19]],[1,[198,0,0]]];
  let i=1;while(i<stops.length-1&&t>stops[i][0])i++;
  const [a,ca]=stops[i-1],[b,cb]=stops[i],w=(t-a)/(b-a);
  return [...ca.map((c,k)=>Math.round(c+(cb[k]-c)*w)),Math.round(255*Math.min(1,.12+1.25*t))];
}

// Same 40 x 20 court and 2 m surround as /scene/futsal-pitch.svg.
// Geometry ported from agusrjs/futsal-pitch (MIT), Copyright 2025 Agustín Rojas.
const markings=[
  'M20 0V20M17 10a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
  'M0 2.17A6 6 0 0 1 6 8.17V11.83A6 6 0 0 1 0 17.83M40 2.17A6 6 0 0 0 34 8.17V11.83A6 6 0 0 0 40 17.83',
  'M0 8.5V11.5M40 8.5V11.5M10 19.7V20.3M15 19.7V20.3M25 19.7V20.3M30 19.7V20.3',
  'M0 .625A.625.625 0 0 0 .625 0M39.375 0A.625.625 0 0 0 40 .625M40 19.375A.625.625 0 0 0 39.375 20M.625 20A.625.625 0 0 0 0 19.375',
];
const spots=[[20,10,.12],[6,10,.12],[10,10,.12],[10,5,.06],[10,15,.06],[34,10,.12],[30,10,.12],[30,5,.06],[30,15,.06]];

// The canvas is the final artwork: court + density only. Player labels and
// quality information belong in the DOM/JSON, never in an exported PNG.
export function paintHeatmap(canvas,result,player){
  canvas.height=Math.round(canvas.width*24/44);
  const ctx=canvas.getContext('2d'),unit=canvas.width/44,pad=2*unit,cw=40*unit,ch=20*unit;
  ctx.fillStyle=QUEENS_CUP_COLORS.surround;ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle=QUEENS_CUP_COLORS.pitch;ctx.fillRect(pad,pad,cw,ch);
  // Keep the existing Gaussian density and shared scale across all players.
  const grid=new Float64Array(result.width*result.height);
  for(let y=0;y<result.height;y++)for(let x=0;x<result.width;x++){
    const value=player.grid[y*result.width+x];if(!value)continue;
    for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++){
      const xx=x+dx,yy=y+dy;
      if(xx>=0&&yy>=0&&xx<result.width&&yy<result.height)grid[yy*result.width+xx]+=value*Math.exp(-(dx*dx+dy*dy)/8);
    }
  }
  const density=document.createElement('canvas');density.width=result.width;density.height=result.height;
  const densityContext=density.getContext('2d'),pixels=densityContext.createImageData(result.width,result.height),max=result.scale||1;
  for(let i=0;i<grid.length;i++){
    pixels.data.set(densityColor(grid[i]/max),i*4);
  }
  densityContext.putImageData(pixels,0,0);
  ctx.imageSmoothingEnabled=true;ctx.drawImage(density,pad,pad,cw,ch);
  // Paint every marking last so the requested line colour stays visible even
  // where a player's density crosses a penalty area, corner or centre line.
  ctx.save();ctx.translate(pad,pad);ctx.scale(unit,unit);
  ctx.strokeStyle=QUEENS_CUP_COLORS.line;ctx.fillStyle=QUEENS_CUP_COLORS.line;ctx.lineWidth=.14;
  ctx.strokeRect(0,0,40,20);
  for(const path of markings)ctx.stroke(new Path2D(path));
  for(const [x,y,r] of spots){ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();}
  ctx.restore();
}
