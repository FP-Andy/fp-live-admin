import {apiJson} from './api';
import type {ReportDraft} from './futsal-report';
import {reportRole} from './futsal-report-positions';
import {automaticPositions} from './futsal-report-auto-position';
export type AssignmentPlayer={id:string;group:'home'|'home_gk'|'away'|'away_gk'|'referee';number:string;box:[number,number,number,number]};
export type ReportAssignment={jobId:string;time:number;width:number;height:number;image:string;players:AssignmentPlayer[]};
const validId=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{32}$/.test(v);
export function assignmentPlayers(raw:unknown):AssignmentPlayer[]{
 if(!Array.isArray(raw)||!raw.length||raw.length>30)throw Error('초기 선수 배정 정보를 확인하세요.');
 const ids=new Set<string>();
 return raw.map(p=>{
  if(!p||typeof p.id!=='string'||ids.has(p.id)||!['home','home_gk','away','away_gk','referee'].includes(p.group)||!Array.isArray(p.box)||p.box.length!==4||!p.box.every((n:unknown)=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1)||p.box[0]>=p.box[2]||p.box[1]>=p.box[3]||typeof p.jersey!=='string'||!p.jersey||p.jersey.length>12)throw Error('초기 선수 좌표·번호를 확인하세요.');
  ids.add(p.id);return {id:p.id,group:p.group,number:p.jersey,box:[...p.box] as AssignmentPlayer['box']};
 });
}
export function validateAssignment(value:ReportAssignment){
 if(!value||!validId(value.jobId)||!Number.isFinite(value.time)||value.time<0||!Number.isFinite(value.width)||!Number.isFinite(value.height)||value.width<=0||value.height<=0||typeof value.image!=='string'||value.image.length>6000000||!/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(value.image))throw Error('선수 배정표의 초기 장면을 확인하세요.');
 assignmentPlayers(value.players.map(p=>({...p,jersey:p.number})));return value;
}
export async function loadReportAssignment(jobId:string):Promise<ReportAssignment>{
 if(!validId(jobId))throw Error('연결된 분석의 초기 설정을 찾을 수 없습니다.');
 const job=await apiJson<{options?:{setup?:{preparationId:string;time:number;roster:unknown}}}>(`/tracking/jobs/${jobId}`),setup=job.options?.setup;
 if(!setup||!validId(setup.preparationId)||!Number.isFinite(setup.time))throw Error('이 분석에 저장된 초기 설정 장면이 없습니다.');
 const players=assignmentPlayers(setup.roster),response=await fetch(`/api/tracking/jobs/${setup.preparationId}/frame.png`);
 if(!response.ok)throw Error('초기 장면을 불러오지 못했습니다. 잠시 후 다시 시도하세요.');
 const blob=await response.blob();if(!blob.type.startsWith('image/')||blob.size>30000000)throw Error('초기 장면 이미지 형식을 확인하세요.');
 const url=URL.createObjectURL(blob),image=new Image();
 try{image.src=url;await image.decode();const canvas=document.createElement('canvas'),ratio=Math.min(1,1920/image.naturalWidth);canvas.width=Math.round(image.naturalWidth*ratio);canvas.height=Math.round(image.naturalHeight*ratio);canvas.getContext('2d')!.drawImage(image,0,0,canvas.width,canvas.height);
  return validateAssignment({jobId,time:setup.time,width:canvas.width,height:canvas.height,image:canvas.toDataURL('image/jpeg',.9),players});
 }finally{URL.revokeObjectURL(url);}
}
export function assignmentNumber(d:ReportDraft,id:string){return d.assignment?.players.find(p=>p.id===id)?.number||d.players[id]?.jersey||'';}
export function assignmentPosition(d:ReportDraft,p:AssignmentPlayer){return automaticPositions(d)[p.id]?.position||'';}
export function assignmentRows(d:ReportDraft,side:'home'|'away'){
 const positions=automaticPositions(d);
 const source=d.assignment?.players||Object.entries(d.players).map(([id,p])=>({id,group:p.side,number:p.jersey,box:[0,0,1,1] as AssignmentPlayer['box']}));
 return source.filter(p=>p.group===side||p.group===side+'_gk').sort((a,b)=>Number(b.group.endsWith('_gk'))-Number(a.group.endsWith('_gk'))||a.number.localeCompare(b.number,undefined,{numeric:true})).map(p=>({...p,role:reportRole(positions[p.id]?.position||''),automatic:positions[p.id]}));
}
