// One file at a time, six concurrent parts; successful parts survive retries.
export async function uploadParts({file,partSize,parts,sign,put,progress=()=>{},concurrency=6,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),now=()=>Date.now()}){
 const count=Math.ceil(file.size/partSize),loaded=new Map(),urls=new Map();let next=1,signing=null,failed=null;
 const bytesFor=n=>Math.min(partSize,file.size-(n-1)*partSize);
 const update=()=>progress([...parts.keys()].reduce((sum,n)=>sum+bytesFor(n),0)+[...loaded.values()].reduce((a,b)=>a+b,0));
 async function urlFor(number){
  while(!urls.has(number)||urls.get(number).expires<=now()){
   if(!signing){
    const numbers=[];for(let n=number;n<=count&&numbers.length<concurrency;n++)if(!parts.has(n))numbers.push(n);
    signing=sign(numbers).then(values=>{for(const item of values)urls.set(item.number,{url:item.url,expires:now()+50*60*1000});}).finally(()=>{signing=null;});
   }
   await signing;
  }
  return urls.get(number).url;
 }
 async function send(){while(next<=count&&!failed){
  const number=next++;if(parts.has(number))continue;
  const blob=file.slice((number-1)*partSize,number*partSize);
  try{
   for(let attempt=0;attempt<4;attempt++){
    try{
     const url=await urlFor(number);
     const etag=await put(url,blob,bytes=>{loaded.set(number,Math.min(blob.size,bytes));update();});
     loaded.delete(number);parts.set(number,etag);update();break;
    }catch(error){loaded.delete(number);urls.delete(number);update();if(attempt===3)throw error;await sleep(1000*2**attempt);}
   }
  }catch(error){failed=error;}
 }}
 update();await Promise.all(Array.from({length:Math.min(concurrency,count)},send));if(failed)throw failed;
 return [...parts].sort((a,b)=>a[0]-b[0]).map(([PartNumber,ETag])=>({PartNumber,ETag}));
}

export function transferMeter(total,now=()=>Date.now()){
 const samples=[];let high=0;
 return bytes=>{
  // Retried bytes do not inflate throughput or make progress move backwards.
  high=Math.max(high,bytes);const time=now();samples.push([time,high]);
  while(samples.length>2&&samples[1][0]<time-15000)samples.shift();
  const seconds=(time-samples[0][0])/1000,rate=seconds>=2?(high-samples[0][1])/seconds:0;
  return {bytes,rate,remaining:rate>0?Math.max(0,(total-bytes)/rate):null};
 };
}
