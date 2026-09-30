export type AnalysisSnapshotSummary={id:string;title:string;jobId:string;datasetId:string;version:number;createdAt:string;createdBy:string;reviewVersion:number;resultVersion:number;matchId:string|null;eventCount:number;meanCoverage:number;minCoverage:number};
export type AnalysisSnapshot=AnalysisSnapshotSummary&{schema:'fpc-analysis-snapshot/v1';heatmap:unknown;fpa:unknown;matchName:string;homeName:string;awayName:string;roster:Array<{id:string;name?:string;position?:string}>};
export function listAnalysisSnapshots(jobId?:string):Promise<AnalysisSnapshotSummary[]>;
export function loadAnalysisSnapshot(id:string):Promise<AnalysisSnapshot>;
export function saveAnalysisSnapshot(value:unknown):Promise<AnalysisSnapshotSummary>;
