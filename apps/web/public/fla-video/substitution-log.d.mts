export type LogTeam='home'|'away';
export type LogVideo={name:string;duration:number;from:number;to:number};
export type LogPlayer={id:string;team:LogTeam;name:string;jersey:string;sourceSlotId?:string};
export type Substitution={id:string;time:number;team:LogTeam;outId?:string;inId?:string;note:string};
export type SubstitutionLog={schema:'fpa-substitution-log/v1'|'fpa-substitution-log/v2';video:LogVideo;players:LogPlayer[];initialPlayers:string[];substitutions:Substitution[]};
export function validateSubstitutionLog(log:unknown,context?:LogVideo):SubstitutionLog;
export function saveSubstitution(log:SubstitutionLog,event:Substitution):SubstitutionLog;
export function removeSubstitution(log:SubstitutionLog,id:string):SubstitutionLog;
export function buildAppearanceIntervals(log:SubstitutionLog):Array<LogPlayer&{stint:number;from:number;to:number;videoSeconds:number}>;
export function exportSubstitutionLog(log:SubstitutionLog):SubstitutionLog&{appearances:ReturnType<typeof buildAppearanceIntervals>;trackingApplied:false};
export function substitutionCsv(log:SubstitutionLog):string;
export function appearancesCsv(log:SubstitutionLog):string;
export function parseLogTime(input:string):number;
export function formatLogTime(seconds:number):string;

export function hasPlayerPair(event:Substitution):boolean;
export function buildSubstitutionWindows(log:SubstitutionLog,radius?:number):Array<{eventId:string;team:LogTeam;time:number;from:number;to:number;boundary:'camera-bottom';identityStatus:'linked'|'pending';trackingApplied:false}>;
