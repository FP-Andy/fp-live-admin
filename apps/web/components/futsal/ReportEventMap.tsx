import {useEffect,useRef} from 'react';
import {paintHeatmap} from '../../public/fpa-cv/heatmap-render.mjs';
import {attackDirection,type ReportDraft,type PlayerText} from '../../lib/futsal-report';
import {eventMapData} from '../../lib/futsal-report-events';
import {reportTeamOptions} from '../../lib/futsal-team-report';
export default function ReportEventMap({draft,person}:{draft:ReportDraft;person:PlayerText}){
 const ref=useRef<HTMLCanvasElement>(null),map=eventMapData(draft,person),colors=reportTeamOptions(draft);
 useEffect(()=>{
  const c=ref.current;if(!c)return;c.width=1320;paintHeatmap(c,{width:80,height:40,scale:1},{grid:Array(3200).fill(0)});
  const ctx=c.getContext('2d')!,u=c.width/44,teamColor=(side:string)=>side==='home'?colors.homeColor:colors.awayColor;
  const ownDirection=attackDirection(draft,person);
  ctx.font='600 25px Arial';ctx.textAlign='center';ctx.fillStyle='#6F3A59';
  ctx.fillText(ownDirection==='right'?'아군 진영':'상대 진영',u*12,u*1.22);ctx.fillText(ownDirection==='right'?'상대 진영':'아군 진영',u*32,u*1.22);
  for(const side of ['home','away'] as const){const dir=attackDirection(draft,{...person,side}),right=dir==='right',color=teamColor(side),lanes=draft.fla?.summary.lanes[side];
   if(lanes?.total_count){[lanes.left_count,lanes.center_count,lanes.right_count].forEach((count,i)=>{const ratio=count/lanes.total_count;if(!ratio)return;
    const x=(right?6:34)*u+2*u,y=(2+(right?i:2-i)*6+4)*u,sign=right?1:-1,len=(3+ratio*8)*u;
    // One filled outline: shaft and head share an edge, with no translucent overlap.
    ctx.save();ctx.globalAlpha=.24;ctx.fillStyle=color;ctx.beginPath();
    ctx.moveTo(x,y-18);ctx.lineTo(x+sign*len,y-18);ctx.lineTo(x+sign*len,y-45);
    ctx.lineTo(x+sign*(len+54),y);ctx.lineTo(x+sign*len,y+45);ctx.lineTo(x+sign*len,y+18);ctx.lineTo(x,y+18);
    ctx.closePath();ctx.fill();ctx.restore();
    ctx.fillStyle='#94637F';ctx.font='24px Arial';ctx.fillText(`${Math.round(ratio*100)}%`,x-sign*42,y+8);
   });}
   ctx.fillStyle=color;ctx.font='600 23px Arial';ctx.fillText(`${side===person.side?'아군':'상대'} 공격 ${right?'→':'←'}`,(right?12:32)*u,23.35*u);
  }
  for(const m of [...map.markers].sort((a,b)=>Number(a.personal)-Number(b.personal))){if(m.x===null||m.y===null)continue;const x=(m.x+2)*u,y=(m.y+2)*u,r=m.personal?15:10,color=teamColor(m.side);
   ctx.save();ctx.globalAlpha=m.personal?1:.5;ctx.fillStyle=color;ctx.strokeStyle=m.personal?'#48283D':'#FFFFFF';ctx.lineWidth=m.personal?3:2;
   if(m.personal){ctx.beginPath();ctx.arc(x,y,r+5,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();ctx.fillStyle=color;}
   ctx.beginPath();if(m.kind==='shot')ctx.arc(x,y,r,0,Math.PI*2);else if(m.kind==='defense'){ctx.moveTo(x,y-r);ctx.lineTo(x+r,y);ctx.lineTo(x,y+r);ctx.lineTo(x-r,y);}else for(let i=0;i<10;i++){const a=-Math.PI/2+i*Math.PI/5,v=i%2?r*.45:r;if(!i)ctx.moveTo(x+Math.cos(a)*v,y+Math.sin(a)*v);else ctx.lineTo(x+Math.cos(a)*v,y+Math.sin(a)*v);}ctx.closePath();ctx.fill();ctx.stroke();ctx.restore();
  }
 },[draft,person,colors.homeColor,colors.awayColor]);
 return <canvas ref={ref} aria-label="양 팀 슈팅·수비 이벤트맵, 해당 선수 강조"/>;
}
