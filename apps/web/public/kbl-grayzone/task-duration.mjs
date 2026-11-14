// Completed jobs with no end timestamp must not keep counting indefinitely.
export function taskElapsedSeconds(task,started,now=Date.now()){
 if(!Number.isFinite(started))return null;
 const terminal=['complete','failed','interrupted'].includes(task.state);
 const ended=terminal?Date.parse(task.completedAt||task.finishedAt||task.updatedAt||''):now;
 return Number.isFinite(ended)?Math.max(0,Math.floor((ended-started)/1000)):null;
}
