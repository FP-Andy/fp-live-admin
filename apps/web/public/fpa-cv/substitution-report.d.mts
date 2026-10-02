import type {HeatSource} from '../../lib/futsal-report';
export type Crossing={trackId:number;time:number;kind:'in'|'out';team:'home'|'away'|null;sourceId:string|null;ownerCertain:boolean;returning?:boolean;box:[number,number,number,number]};
export type SubstitutionResultEvent={id:string;team:'home'|'away';time:number;status:'review'|'automatic'|'confirmed';reason?:string;outPersonId?:string;inPersonId?:string;outNumber?:string;inNumber?:string;outTime?:number;inTime?:number;outTrackId?:number;inTrackId?:number;entryBox?:[number,number,number,number];outs:Crossing[];ins:Crossing[];people:Array<{id:string;number:string}>};
export type SubstitutionReport={provenance:{algorithm:string;snapshotId:string;jobId:string;logRevision:number;matchId:string|null};status:'ready'|'review';events:SubstitutionResultEvent[];heatmap:HeatSource;images?:Record<string,string>};
export const SUBSTITUTION_REPORT_VERSION:string;
export function deriveSubstitutionReport(snapshot:unknown,data:unknown,saved:unknown,progress?:(p:unknown)=>void):SubstitutionReport;
