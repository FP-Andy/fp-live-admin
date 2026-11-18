const labels={objects:'객체',joints:'관절',spatial:'2D·3D',report:'리포트'};

// This uses saved server checkpoints, never client guesses or intake status.
export function workProgress(flow,job){
 const stage=Object.hasOwn(labels,flow?.activeStage)?flow.activeStage:'objects';
 const caseId=encodeURIComponent(flow?.caseId||'');
 const event=/^review-\d+$/.test(flow?.nextEventId||'')?flow.nextEventId:'review-1';
 const count=flow?.stages?.[stage];
 const title=stage==='report'?'리포트 단계':`${labels[stage]} 단계 · ${Number(count?.completed)||0}/${Number(count?.total)||0}장면 확인`;
 const stages=['objects','joints','spatial'].map(key=>`${labels[key]} ${Number(flow?.stages?.[key]?.completed)||0}/${Number(flow?.stages?.[key]?.total)||0}`).join(' · ');
 const file=stage==='spatial'?'reconstruction.html':stage==='report'?'report-review.html':'pose-review.html';
 const query=`id=${caseId}`+(['objects','joints'].includes(stage)?`&stage=${stage}`:'');
 let video='';
 if(job&&['queued','running'].includes(job.state))video=job.stage||'PDF·영상 제작 중';
 else if(job?.state==='partial'||job?.state==='failed'||job?.state==='interrupted')video='PDF·영상 제작에 확인이 필요합니다.';
 else if(job?.state==='complete')video='PDF·영상 제작 완료';
 return {title,stages,video,path:`${file}?${query}#${event}`};
}
