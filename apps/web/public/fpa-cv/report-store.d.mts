export function saveReport(record: { id: string; title: string; updatedAt: string; [key: string]: unknown }): Promise<unknown>;
export function loadReport(id: string): Promise<unknown>;
export function listReports(): Promise<Array<{ id: string; title: string; updatedAt: string }>>;
