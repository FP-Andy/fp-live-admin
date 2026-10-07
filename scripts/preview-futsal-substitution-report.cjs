/** Local-only report preview. All log writes are in memory; no production requests. */
const fs=require('fs'),zlib=require('zlib'),http=require('http'),path=require('path');
const dir=process.env.SUB_REPORT_FIXTURE;if(!dir)throw Error('Set SUB_REPORT_FIXTURE to the local diagnostic fixture directory');
const b=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir,'source-bundle.json.gz')))),api=JSON.parse(fs.readFileSync(path.join(dir,'api.json'))),snapshot=b.snapshot;
let saved=b.log;const trackBody=JSON.stringify(b.tracks),snapshotBody=JSON.stringify(snapshot),videoFile=process.env.SUB_REPORT_VIDEO;
const port=Number(process.env.SUB_REPORT_API_PORT||5452),web=process.env.SUB_REPORT_WEB_ORIGIN||'http://127.0.0.1:5451';
http.createServer(async(req,res)=>{const u=new URL(req.url,'http://localhost'),p=u.pathname;res.setHeader('Cache-Control','no-store');
 const send=(v,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(typeof v==='string'?v:JSON.stringify(v));};
 if(p==='/preview'){res.writeHead(302,{'Set-Cookie':'live_admin_session=local-substitution-preview; Path=/; HttpOnly; SameSite=Lax','Location':web+'/admin/fcm/futsal/reports?match='+b.match.id});res.end();return;}
 if(p==='/api/session/me')return send({id:'local-preview',name:'로컬 교체 검수 · 저장은 미리보기에만 반영',role:'SUPERADMIN'});
 if(p.endsWith('/substitutions')&&req.method==='PUT'){let raw='';for await(const c of req)raw+=c;const value=JSON.parse(raw);if(value.revision!==saved.revision)return send({detail:'revision conflict'},409);saved={revision:saved.revision+1,log:value.log};return send({substitutions:saved});}
 if(p.endsWith('/tracks.json'))return send(trackBody);
 if(p==='/api/futsal/analysis-snapshots')return send({snapshots:[{...snapshot,heatmap:undefined,review:undefined,fpa:undefined}]});
 if(p==='/api/futsal/analysis-snapshots/'+snapshot.id)return send(snapshotBody);
 if(p==='/api/tracking/jobs/'+snapshot.jobId)return send(b.job);
 if(p.endsWith('/frame.png')&&process.env.SUB_REPORT_FRAME){res.setHeader('Content-Type','image/png');fs.createReadStream(process.env.SUB_REPORT_FRAME).pipe(res);return;}
 if(p.endsWith('/report-frame')&&process.env.SUB_REPORT_FRAMES){const t=Number(u.searchParams.get('time')),names=fs.readdirSync(process.env.SUB_REPORT_FRAMES).filter(x=>x.endsWith('.jpg')),name=names.find(x=>Math.abs(Number(x.slice(0,-4))-t)<.003);if(!name)return send({detail:'Scene not in this local fixture'},404);res.setHeader('Content-Type','image/jpeg');fs.createReadStream(path.join(process.env.SUB_REPORT_FRAMES,name)).pipe(res);return;}
 if(p.endsWith('/source')){if(process.env.SUB_REPORT_SOURCE_URL_FILE){const target=fs.readFileSync(process.env.SUB_REPORT_SOURCE_URL_FILE,'utf8').trim();if(u.searchParams.get('canvas')!=='1'){res.writeHead(302,{Location:target});res.end();return;}const controller=new AbortController();res.on('close',()=>controller.abort());try{const upstream=await fetch(target,{headers:req.headers.range?{Range:req.headers.range}:{},signal:controller.signal});res.statusCode=upstream.status;for(const h of ['content-type','content-length','content-range','accept-ranges'])if(upstream.headers.has(h))res.setHeader(h,upstream.headers.get(h));require('stream').Readable.fromWeb(upstream.body).on('error',()=>res.end()).pipe(res);}catch{if(!res.headersSent)res.statusCode=502;res.end();}return;}if(!videoFile)return send({detail:'로컬 미리보기에 영상 파일을 지정하세요.'},404);const size=fs.statSync(videoFile).size,range=req.headers.range?.match(/bytes=(\d+)-(\d*)/),start=range?Number(range[1]):0,end=range&&range[2]?Math.min(size-1,Number(range[2])):size-1;res.writeHead(range?206:200,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':end-start+1,...(range?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})});fs.createReadStream(videoFile,{start,end}).pipe(res);return;}
 if(p==='/api/futsal/fla-video/fixtures')return send({fixtures:[{...b.match.metadata.fla_fixture,match_id:b.match.id,home:snapshot.homeName,away:snapshot.awayName,video:{started:true,ended:true}}]});
 if(p==='/api/futsal/fla-video/matches/'+b.match.id)return send({...api.video,substitutions:saved,can_write_substitutions:true});
 if(p==='/api/matches/'+b.match.id)return send(b.match);
 if(p.endsWith('/summary'))return send(api.summary);if(p.endsWith('/dominance'))return send(api.dominance);if(p.startsWith('/api/broadcast/matches/'))return send(api.score);
 return send({items:[],total:0});
}).listen(port,'127.0.0.1',()=>console.log(`Local-only preview: http://127.0.0.1:${port}/preview`));
