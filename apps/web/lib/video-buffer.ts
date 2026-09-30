export function bufferedSeconds(ranges: Pick<TimeRanges,'length'|'start'|'end'>, time:number, rate=1):number {
  for(let i=0;i<ranges.length;i++)if(ranges.start(i)<=time+.05&&ranges.end(i)>time)return (ranges.end(i)-time)/Math.max(.25,rate);
  return 0;
}
export function sameVideoFile(file:Pick<File,'name'|'size'>, upload:{name?:string;size?:number}):boolean {
  return !!upload.name && !!upload.size && file.name.normalize('NFC')===upload.name.normalize('NFC') && file.size===upload.size;
}
