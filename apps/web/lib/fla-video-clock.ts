export type Team = 'HOME' | 'AWAY' | 'NONE';
export type Segment = {start_ms:number;end_ms:number;team:Team};
export type VideoState = {configured:boolean;version:number;upload_id?:string;offset_ms:number;duration_ms:number;cursor_ms:number;frontier_ms:number;started:boolean;ended:boolean;possession_team:Team;selected_team:'HOME'|'AWAY';direction:'L2R'|'R2L';rate:number};
export const emptyVideoState = ():VideoState => ({configured:false,version:0,offset_ms:0,duration_ms:0,cursor_ms:0,frontier_ms:0,started:false,ended:false,possession_team:'NONE',selected_team:'HOME',direction:'L2R',rate:1});

/** Only natural playback can extend possession. Replay changes the event cursor. */
export class VideoClock {
  state:VideoState;
  pending:Segment[]=[];
  playing=false;
  constructor(state:Partial<VideoState>={},public archived=false) {this.state={...emptyVideoState(),...state,configured:state.configured??Boolean(state.upload_id&&(state.duration_ms||0)>0)};}
  get readOnly(){return this.archived||this.state.ended;}
  get reviewing(){return this.state.started&&this.state.cursor_ms<this.state.frontier_ms;}
  tick(mediaMs:number){
    const s=this.state;
    const cursor=Math.max(0,Math.min(s.duration_ms-s.offset_ms,Math.round(mediaMs)-s.offset_ms));
    const wasReview=this.reviewing;
    s.cursor_ms=cursor;
    if(this.playing&&s.started&&!this.readOnly&&cursor>s.frontier_ms){
      const last=this.pending[this.pending.length-1];
      if(last&&last.team===s.possession_team&&last.end_ms===s.frontier_ms)last.end_ms=cursor;
      else this.pending.push({start_ms:s.frontier_ms,end_ms:cursor,team:s.possession_team});
      s.frontier_ms=cursor;
      if(wasReview&&s.possession_team!=='NONE')s.selected_team=s.possession_team;
    }
  }
  seek(mediaMs:number){
    const s=this.state;const cursor=Math.max(0,Math.round(mediaMs)-s.offset_ms);
    if(s.started&&!this.readOnly&&cursor>s.cursor_ms)return false;
    this.playing=false;s.cursor_ms=Math.min(Math.max(0,s.duration_ms-s.offset_ms),cursor);return true;
  }
  choose(team:Team){
    if(team!=='NONE')this.state.selected_team=team;
    if(!this.reviewing&&!this.readOnly)this.state.possession_team=team;
  }
  acknowledge(version:number,through:number){
    this.state.version=version;
    this.pending=this.pending.filter(s=>s.end_ms>through).map(s=>({...s,start_ms:Math.max(s.start_ms,through)}));
  }
  snapshot(){return {...this.state,segments:this.pending.map(s=>({...s}))};}
}

export function videoHotkey(event:Pick<KeyboardEvent,'code'|'repeat'|'ctrlKey'|'altKey'|'metaKey'>){
  if(event.repeat||event.ctrlKey||event.altKey||event.metaKey)return null;
  return ['Space','KeyQ','KeyW','KeyE','KeyA','KeyS','KeyD','Enter'].includes(event.code)?event.code:null;
}
export function formatVideoTime(ms:number){const seconds=Math.floor(Math.max(0,ms)/1000);return `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;}
