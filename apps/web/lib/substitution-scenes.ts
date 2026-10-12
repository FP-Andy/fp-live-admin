// The frame API has two decoder slots. Opening a simultaneous-substitution
// gallery must queue its stills instead of flooding those slots with requests.
const cached=new Map<string,string>(),pending=new Map<string,Promise<string>>(),queue:Array<()=>void>=[];
let active=0;
function drain(){while(active<2&&queue.length){active++;queue.shift()!();}}
export function substitutionScene(url:string):Promise<string>{
 const hit=cached.get(url);if(hit){cached.delete(url);cached.set(url,hit);return Promise.resolve(hit);}
 const inFlight=pending.get(url);if(inFlight)return inFlight;
 const promise=new Promise<string>((resolve,reject)=>{
  queue.push(()=>{void(async()=>{
   try{
    let response:Response|undefined;
    for(let attempt=0;attempt<3;attempt++){
     response=await fetch(url,{signal:AbortSignal.timeout(45000)});
     if(response.status!==503)break;
     if(attempt<2)await new Promise(done=>setTimeout(done,1500*(attempt+1)));
    }
    if(!response?.ok)throw Error('장면을 불러오지 못했습니다. 크게 보기를 다시 열어 주세요.');
    const blob=await response.blob();if(!blob.type.startsWith('image/')||blob.size>4*1024*1024)throw Error('장면 이미지 형식을 확인하세요.');
    const image=URL.createObjectURL(blob);cached.set(url,image);
    while(cached.size>32){const oldest=cached.keys().next().value!;URL.revokeObjectURL(cached.get(oldest)!);cached.delete(oldest);}
    resolve(image);
   }catch(error){reject(error);}finally{pending.delete(url);active--;drain();}
  })();});
 });
 pending.set(url,promise);drain();return promise;
}
