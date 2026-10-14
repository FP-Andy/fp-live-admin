import fs from 'node:fs';
// Schedule only; each execution must fetch the pinned snapshot and latest logs
// again, and use plan-futsal-substitution-redetection to bind exact source data.
const [comparisonFile,sourceIndexFile,output]=process.argv.slice(2);if(!output)throw Error('Usage: node scripts/plan-futsal-substitution-redetection-batch.mjs comparison.json source-index.json queue.json');
const comparison=JSON.parse(fs.readFileSync(comparisonFile)),source=JSON.parse(fs.readFileSync(sourceIndexFile)),matches=[];
for(const game of comparison.fixtures){if(game.status!=='review'&&!game.events.some(e=>e.trackingStatus==='partial'))continue;const entry=source.matches.find(m=>m.id===game.matchId);if(!entry||entry.revision!==game.logRevision)throw Error('Stale log index');
 const pending=game.events.filter(e=>e.status==='review'||e.trackingStatus==='partial'),windows=[];
 for(const e of [...pending].sort((a,b)=>a.time-b.time)){const from=Math.max(entry.log.video.from,e.time-16),to=Math.min(entry.log.video.to,e.time+24),last=windows.at(-1);if(last&&from<=last.to&&to-last.from<=80){last.to=Math.max(last.to,to);last.eventIds.push(e.id);}else windows.push({from,to,eventIds:[e.id]});}
 matches.push({matchId:game.matchId,name:game.name,snapshotId:game.snapshotId,logRevision:game.logRevision,status:'planned',requiresSourceValidation:true,windows,seconds:windows.reduce((n,w)=>n+w.to-w.from,0)});
}
const queue={schema:'fpc-substitution-redetection-queue/v1',createdAt:new Date().toISOString(),matches,totals:{matches:matches.length,logs:matches.reduce((n,m)=>n+m.windows.flatMap(w=>w.eventIds).length,0),windows:matches.reduce((n,m)=>n+m.windows.length,0),seconds:matches.reduce((n,m)=>n+m.seconds,0)},concurrency:1,model:'YOLO26s',applyPolicy:'No original snapshot writes; inspect regression guard and evidence before publishing'};
fs.writeFileSync(output,JSON.stringify(queue,null,2));console.log(JSON.stringify(queue.totals));
