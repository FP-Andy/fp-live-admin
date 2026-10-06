import type {Segment,VideoState} from './fla-video-clock';
export type PendingRecording={request_id:string;client_id:string;version:number;action:'start'|'save'|'finish';cursor_ms:number;frontier_ms:number;possession_team:string;selected_team:string;direction:string;rate:number;segments:Segment[]};
export type RecordingRecovery={client:string;state:VideoState;segments:Segment[];request:PendingRecording|null};
const memory=new Map<string,RecordingRecovery>();
export function recordingJournal(key:string,record:RecordingRecovery|null){
 if(!key)return false;
 if(record)memory.set(key,record);else memory.delete(key);
 try{if(record)sessionStorage.setItem(key,JSON.stringify(record));else sessionStorage.removeItem(key);return true;}catch{return false;}
}
export function recoverRecording(key:string):RecordingRecovery|null{
 if(memory.has(key))return memory.get(key)!;
 try{const value=JSON.parse(sessionStorage.getItem(key)||'null');if(value?.state&&Array.isArray(value.segments)&&typeof value.client==='string')return value;}catch{}
 return null;
}
