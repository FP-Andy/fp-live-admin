// Local-only, read-only experiment viewer. No production APIs or credentials.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),[dir,port='4358']=process.argv.slice(2);
if(!dir)throw Error('Supply the experiment results directory.');
const files=new Map([
  ['/',[path.join(here,'fpa-cv-heatmap-reconstruction-preview.html'),'text/html; charset=utf-8']],
  ['/heatmap-render.mjs',[path.join(here,'../apps/web/public/fpa-cv/heatmap-render.mjs'),'text/javascript']],
  ...['results.json','augmentation-results.json','training-preview.json','heldout-preview.json'].map(name=>['/'+name,[path.join(dir,name),'application/json']])
]);
http.createServer((req,res)=>{
  const entry=files.get(new URL(req.url,'http://127.0.0.1').pathname);
  if(req.method!=='GET'||!entry){res.writeHead(404);res.end();return;}
  if(!fs.existsSync(entry[0])){res.writeHead(404);res.end('Run the experiment first.');return;}
  res.writeHead(200,{'Content-Type':entry[1],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'"});fs.createReadStream(entry[0]).pipe(res);
}).listen(Number(port),'127.0.0.1',()=>console.log(`Read-only experiment: http://127.0.0.1:${port}`));
