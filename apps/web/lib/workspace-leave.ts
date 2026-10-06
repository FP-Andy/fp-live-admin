const guards=new Set<()=>boolean|Promise<boolean>>();
let leaving:Promise<boolean>|null=null;
export function registerWorkspaceLeave(guard:()=>boolean|Promise<boolean>){guards.add(guard);return()=>{guards.delete(guard);};}
export function allowWorkspaceLeave():Promise<boolean>{
 if(leaving)return leaving;
 leaving=(async()=>{for(const guard of guards)if(!await guard())return false;return true;})().finally(()=>{leaving=null;});
 return leaving;
}
