export const HEATMAP_EXPORT_SIZE: Readonly<{width:number;height:number}>;
export type AugmentedPlayer={grid:number[];augmentation?:{schema:string;estimatedGrid:number[]}};
export type HeatmapDisplay={width:number;height:number;scale?:number;augmentation?:{enabled:boolean}};
export function paintHeatmap(canvas: HTMLCanvasElement,result: HeatmapDisplay,player: AugmentedPlayer): void;
export function displayedHeatmapGrid(result: HeatmapDisplay,player: AugmentedPlayer):number[];
export function heatmapDensityScale(result: HeatmapDisplay&{players:AugmentedPlayer[]}):number;
export function densityColor(value:number): number[];
