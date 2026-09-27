import {recoveryInputs} from './recovery-protocol.mjs';

const aborted=()=>new DOMException('이전 선수 연결 계산을 중지했습니다.','AbortError');

export class RecoveryClient {
  constructor({createWorker=()=>new Worker(new URL('./recovery-worker.mjs',import.meta.url),{type:'module'}),onProgress=()=>{}}={}) {
    this.createWorker=createWorker;this.onProgress=onProgress;this.serial=0;this.pending=null;this.worker=null;this.source=null;this.contentHash=null;
  }
  cancel() {
    this.worker?.terminate();this.worker=null;
    this.pending?.reject(aborted());this.pending=null;
  }
  request(type,fields) {
    if(!this.worker) {
      const worker=this.createWorker();this.worker=worker;
      worker.onmessage=({data:message})=>{
        const pending=this.pending;
        if(this.worker!==worker||!pending||message.id!==pending.id)return;
        if(message.type==='progress'){this.onProgress(message);return;}
        this.pending=null;
        if(message.type==='error')pending.reject(Error(message.message));
        else pending.resolve(message);
      };
      worker.onerror=event=>{
        if(this.worker!==worker)return;
        const pending=this.pending;this.pending=null;worker.terminate();this.worker=null;
        pending?.reject(Error(event.message||'선수 연결 계산을 시작하지 못했습니다. 다시 시도해 주세요.'));
      };
    }
    return new Promise((resolve,reject)=>{
      const id=++this.serial;this.pending={id,resolve,reject};
      try{this.worker.postMessage({type,id,...fields});}
      catch(error){this.pending=null;reject(error);}
    });
  }
  async load(source) {
    this.cancel();this.source=source;this.contentHash=null;
    const response=await this.request('load',{source,sendData:true});
    this.contentHash=response.contentHash;return response.data;
  }
  async compute(review) {
    if(!this.source||!this.contentHash)throw Error('트래킹 결과를 다시 열어 주세요.');
    const inputs=structuredClone(recoveryInputs(review));
    // A synchronous calculation cannot receive a cancel message while busy.
    // Terminate it instead, and reload its data privately before recalculating.
    if(this.pending)this.cancel();
    if(!this.worker)await this.request('load',{source:this.source,expectedHash:this.contentHash,sendData:false});
    return this.request('compute',{review:inputs});
  }
}
