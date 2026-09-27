import React from 'react';
import { createRoot } from 'react-dom/client';
import FpaLiveEditor, { FpaCvWorkbench } from '../components/fpa/FpaLiveEditor';
import { SportProvider } from '../components/SportContext';

const channel = 'fpa-cv/fpc-v1';
const root = createRoot(document.getElementById('root')!);
let generation = 0;
let datasetId = '';
let session = '';
const timeRequests=new Map<string,{resolve:(time:number)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
const listeners = new Set<(message: any) => void>();
const send = (message: Record<string, unknown>) => window.parent.postMessage({ channel, datasetId, session, ...message }, window.location.origin);
window.addEventListener('message', event => {
  if (event.source !== window.parent || event.origin !== window.location.origin || event.data?.channel !== channel) return;
  const message = event.data;
  if (message.type === 'request-ready') { send({ type: 'ready' }); return; }
  if (message.type === 'init') {
    datasetId = message.datasetId;
    session = message.session;
    for(const pending of timeRequests.values()){clearTimeout(pending.timer);pending.reject(Error('영상이 변경되었습니다. 다시 입력하세요'));}
    timeRequests.clear();listeners.clear();
    const activeSession=session, activeDataset=datasetId;
    const workbench: FpaCvWorkbench = { ...message, readTime:()=>new Promise<number>((resolve,reject)=>{
      const requestId=crypto.randomUUID();
      const timer=setTimeout(()=>{timeRequests.delete(requestId);reject(Error('영상 시각을 읽지 못했습니다. 다시 입력하세요'));},5000);
      timeRequests.set(requestId,{resolve,reject,timer});send({type:'get-time',requestId});
    }), send:payload=>window.parent.postMessage({channel,datasetId:activeDataset,session:activeSession,...payload},window.location.origin), subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
    root.render(<SportProvider key={++generation}><FpaLiveEditor workbench={workbench} /></SportProvider>);
  } else if (message.datasetId === datasetId && message.session === session) {
    if(message.type==='time' && message.requestId){const pending=timeRequests.get(message.requestId);if(pending){clearTimeout(pending.timer);timeRequests.delete(message.requestId);pending.resolve(message.time);}}
    for (const listener of listeners) listener(message);
  }
});
let lastHeight = 0;
new ResizeObserver(() => {
  const height = Math.ceil(document.getElementById('root')!.getBoundingClientRect().height)+2;
  if (height !== lastHeight) { lastHeight = height; send({ type: 'height', height }); }
}).observe(document.getElementById('root')!);
send({ type: 'ready' });
