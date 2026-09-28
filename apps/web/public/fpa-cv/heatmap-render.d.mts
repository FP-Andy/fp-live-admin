export const HEATMAP_EXPORT_SIZE: Readonly<{width:number;height:number}>;
export function paintHeatmap(canvas: HTMLCanvasElement,result: {width:number;height:number;scale?:number},player: {grid:number[]}): void;
export function densityColor(value:number): number[];
