export function saveReport(record: { id: string; title: string; updatedAt: string; [key: string]: unknown }, expectedOwner?:string): Promise<unknown>;
export function loadReport(id: string, expectedOwner?:string): Promise<unknown>;
export function listReports(expectedOwner?:string): Promise<Array<{ id: string; title: string; updatedAt: string }>>;
export function listLegacyReports():Promise<Array<{id:string;title:string;updatedAt:string}>>;
export function copyLegacyReport(id:string):Promise<string>;
