export type ActivityPolicy={enabled:true;algorithm:string;targetRatio:number;targetBasis:'duration';use:'heatmap-only'};
export type ActivityDensity={schema:string;algorithm:string;from:number;to:number;inferredSeconds:number;estimatedGrid:number[];gaps:Array<{from:number;to:number;inferredSeconds:number;kind:string}>};
export function validateHeatmapAugmentation(source:unknown):void;
