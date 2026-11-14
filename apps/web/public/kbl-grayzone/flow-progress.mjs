export function progress(events=[]){
 return {total:events.length,objects:events.filter(e=>e.stages.objects.complete).length,
  joints:events.filter(e=>e.stages.joints.complete).length,spatial:events.filter(e=>e.stages.spatial.complete).length};
}
export function nextIncomplete(events=[],stage='spatial'){return events.find(e=>!e.stages[stage].complete)||null;}
export function stageAllowed(data,stage,eventId){
 if(stage==='frame')return true;
 if(stage==='report')return !!data?.reportReady;
 return !!data?.stages?.[stage]?.available&&(!eventId||!!data.events.find(e=>e.id===eventId)?.stages[stage]?.available);
}
export function nextWork(data,stage){
 const remaining=nextIncomplete(data.events,stage);
 if(remaining)return {stage,eventId:remaining.id};
 return {stage:data.activeStage,eventId:data.nextEventId||data.events[0]?.id};
}
