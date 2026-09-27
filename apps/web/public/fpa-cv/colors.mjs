// D65 Lab distance with reduced luminance weight: a matching heuristic, not a
// calibrated probability. Preserve several operator samples for shade/stripes.
const labCache=new Map();
export function rgbToLab(rgb) {
  const key=rgb.join(',');if(labCache.has(key))return labCache.get(key);
  const [r,g,b] = rgb.map(v => { const s=v/255; return s<=.04045?s/12.92:((s+.055)/1.055)**2.4; });
  const f=v=>v>.008856?Math.cbrt(v):7.787*v+16/116;
  const x=f((.4124564*r+.3575761*g+.1804375*b)/.95047);
  const y=f(.2126729*r+.7151522*g+.072175*b);
  const z=f((.0193339*r+.119192*g+.9503041*b)/1.08883);
  const value=[116*y-16,500*(x-y),200*(y-z)];
  if(labCache.size>=16384)labCache.clear();labCache.set(key,value);return value;
}
export function colorDistance(a,b) {
  const x=rgbToLab(a),y=rgbToLab(b);
  return Math.hypot((x[0]-y[0])*.5,x[1]-y[1],x[2]-y[2]);
}
export const validRGB=rgb=>Array.isArray(rgb)&&rgb.length===3&&rgb.every(v=>Number.isFinite(v)&&v>=0&&v<=255);
export const hex=rgb=>'#'+rgb.map(v=>Math.round(v).toString(16).padStart(2,'0')).join('');

// A bright eyedropper sample also needs to match shaded cloth. Chromatic
// uniforms use Lab hue with lighter penalties for lightness/chroma changes;
// near-neutral shirts still use the ordinary Lab distance.
export function uniformDistance(a,b) {
  const x=rgbToLab(a),y=rgbToLab(b),cx=Math.hypot(x[1],x[2]),cy=Math.hypot(y[1],y[2]);
  const saturation=rgb=>(Math.max(...rgb)-Math.min(...rgb))/(Math.max(...rgb)||1);
  if(cx<18||cy<18||saturation(a)<.30||saturation(b)<.30)return colorDistance(a,b);
  return Math.hypot(55*(x[1]/cx-y[1]/cy),55*(x[2]/cx-y[2]/cy),.20*(x[0]-y[0]),.15*(cx-cy));
}

let lastUniformKey='',classificationCache=new WeakMap();
export function classifyUniform(appearance, uniforms) {
  if (!appearance?.length) return {group:null,strength:0,margin:0,scores:{}};
  // Palettes can be edited in place during setup. A value key avoids stale
  // colours while sharing repeated observations across offline analysis stages.
  const key=JSON.stringify(uniforms);
  if(key!==lastUniformKey){lastUniformKey=key;classificationCache=new WeakMap();}
  if(classificationCache.has(appearance))return classificationCache.get(appearance);
  const scores={};
  for(const [group,samples] of Object.entries(uniforms)) {
    scores[group]=samples.length ? appearance.reduce((sum,p)=> {
      const distance=Math.min(...samples.map(rgb=>uniformDistance(p.rgb,rgb)));
      return sum+p.weight*Math.max(0,1-distance/32)**2;
    },0) : 0;
  }
  const ranked=Object.entries(scores).sort((a,b)=>b[1]-a[1]);
  const [group,strength]=ranked[0]||[null,0], second=ranked[1]?.[1]||0;
  const margin=strength>0?(strength-second)/strength:0;
  const value={group:strength>=.10&&margin>=.28?group:null,strength,margin,scores};classificationCache.set(appearance,value);return value;
}

export function samplePatch(ctx,x,y,width,height,radius=2) {
  const left=Math.max(0,Math.round(x)-radius),top=Math.max(0,Math.round(y)-radius);
  const w=Math.min(width-left,radius*2+1),h=Math.min(height-top,radius*2+1);
  if(w<1||h<1)throw Error('영상 내부의 유니폼을 클릭하세요.');
  const rgba=ctx.getImageData(left,top,w,h).data, channels=[[],[],[]];
  for(let i=0;i<rgba.length;i+=4)for(let c=0;c<3;c++)channels[c].push(rgba[i+c]);
  return channels.map(a=>a.sort((x,y)=>x-y)[Math.floor(a.length/2)]);
}
