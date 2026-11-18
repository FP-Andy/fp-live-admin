const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=process.env.COURTSIDE_QA_ROOT||path.resolve(__dirname,'..'),pub=path.join(root,'apps/web/public/kbl-grayzone'),caseId='game-test',eid='review-1',old='a'.repeat(24),newId='b'.repeat(24),job='c'.repeat(24),variant='d'.repeat(24),key='x'.repeat(43);
const people=[{id:'r1',role:'referee',xy:[1,1]},{id:'r2',role:'referee',xy:[25,1]},{id:'r3',role:'referee',xy:[25,14]},{id:'p1',role:'player',xy:[12,7]}];
const frame={frameIndex:0,t:0,boxes:people.map(p=>({id:p.id,roleHint:p.role,box:[.1,.1,.2,.5]})),floorPositions:people,court:{},ballObjects:[]};
const entities=people.map(p=>({id:p.id,role:p.role,x:p.xy[0],y:p.xy[1],positionSource:'manual',bodyHeading:0}));
const state={entities,observerId:'r1',targetId:'p1',headingMode:'target-assumption',heading:0,hfov:100,vfov:70,targetHeight:1.1,viewpointId:'r1'};
const event={id:eid,number:1,quarter:1,gameClock:'5:22',recordedDecision:'유지',selectedBroadcastFrame:0,broadcast:{file:'fake.mp4'}};
const stage={available:true,complete:true,ready:true,token:'test'};
const flow={caseId,title:'Test',activeStage:'report',reportReady:true,revision:1,events:[{id:eid,number:1,quarter:1,gameClock:'5:22',frameIndex:0,stages:{objects:stage,joints:stage,spatial:stage}}],stages:{objects:stage,joints:stage,spatial:stage}};
const pose={jobId:job,revision:1,people:[],meshUrl:'/fake-mesh.json'};let captured;
const send=(r,d)=>{const b=Buffer.from(JSON.stringify(d));r.writeHead(200,{'content-type':'application/json','content-length':b.length});r.end(b);};
const server=http.createServer((q,r)=>{const u=new URL(q.url,'http://127.0.0.1');const p=u.pathname;
 if(q.method==='POST'){let s='';q.on('data',d=>s+=d);q.on('end',()=>{if(p.endsWith('/pose-variant-jobs'))return send(r,{job:{jobId:job,captureId:old,state:'complete',result:{variantId:variant,pose,selectedCount:0}}});if(p.endsWith('/reconstruction')){if(q.headers['x-courtside-auto-key']!==key){r.writeHead(403);return r.end();}captured=JSON.parse(s);return send(r,{captureId:newId});}return send(r,{});});return;}
 if(p===`/api/cases/${caseId}`)return send(r,{id:caseId,title:'Test',home:'A',away:'B',revision:1,events:[event],referees:[]});
 if(p.endsWith('/review-flow'))return send(r,flow);
 if(p.endsWith('/broadcast-tracking'))return send(r,{datasetId:'ds',inputSha256:'x'.repeat(64),fps:30,frames:[frame],uniforms:{home:'#fff',away:'#000',revision:0}});
 if(p.endsWith('/reconstruction'))return send(r,{saved:{captureId:old,state,poseJobId:job},captureVersion:old});
 if(p.endsWith('/pose'))return send(r,{pose:{job:{state:'complete',result:pose}}});
 if(p==='/fake-mesh.json')return send(r,{schema:'kbl-mpfb-mesh/v1',assets:{}});
 if(p.endsWith('/wide-reference'))return send(r,{version:'v',sources:[],referees:[],supplementalReferees:[],broadcastRefereeCount:3,identities:{}});
 if(p.endsWith('/sequence'))return send(r,{});
 if(p.endsWith('/work-sessions'))return send(r,{});
 const f=path.resolve(pub,'.'+decodeURIComponent(p));if(!f.startsWith(pub+path.sep)||!fs.existsSync(f)||!fs.statSync(f).isFile()){r.writeHead(404);return r.end();}
 const typ={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2'};r.writeHead(200,{'content-type':typ[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(r);
});
server.listen(0,'127.0.0.1',()=>{const c=cp.spawn('node',[path.join(root,'scripts/kbl_grayzone/render_auto_pose.mjs')],{env:{...process.env,COURTSIDE_PLAYWRIGHT_ROOT:process.env.COURTSIDE_PLAYWRIGHT_ROOT||path.join(root,'apps/web'),KBL_CHROME_PATH:process.env.KBL_CHROME_PATH||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'/usr/bin/chromium')}});let out='',err='';c.stdout.on('data',d=>out+=d);c.stderr.on('data',d=>err+=d);c.stdin.end(JSON.stringify({caseId,eventId:eid,key,port:server.address().port}));c.on('close',code=>{const wanted=['map','overview','eye','crewMap','eye1','eye2','eye3'];let result;try{result=JSON.parse(out);}catch{} const valid=code===0&&result?.previousCaptureId===old&&result?.captureId===newId&&captured?.expectedCaptureId===old&&captured?.poseVariantId===variant&&wanted.every(name=>captured?.images?.[name]?.startsWith('data:image/jpeg'));if(!valid){console.error(JSON.stringify({code,out,err:err.slice(-3000),capture:captured&&{expectedCaptureId:captured.expectedCaptureId,poseVariantId:captured.poseVariantId,images:Object.keys(captured.images||{})}}));process.exitCode=1;}else console.log('Real reconstruction page captured the shared pose and all seven scene views.');server.close();});setTimeout(()=>{c.kill();server.close();console.error('timeout');process.exitCode=1;},180000).unref();});
