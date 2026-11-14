import {courtToImage,imageToCourt,validCalibration} from "./geometry.mjs";
import {samplePatch,hex} from "./colors.mjs";
const names=["먼 쪽 왼쪽 모서리","먼 쪽 중앙","먼 쪽 오른쪽 모서리","왼쪽 엔드라인 중앙","코트 중심","오른쪽 엔드라인 중앙","가까운 왼쪽 모서리","가까운 중앙","가까운 오른쪽 모서리"];
const $=id=>document.getElementById(id);
export class CourtSetup {
  constructor(onApply){
    this.onApply=onApply;this.canvas=$("setupCanvas");this.ctx=this.canvas.getContext("2d");
    this.source=document.createElement("canvas");this.source.width=1920;this.source.height=1080;
    this.sourceCtx=this.source.getContext("2d",{willReadFrequently:true});
    this.canvas.onpointerdown=e=>this.pointer(e,"down");
    this.canvas.onpointermove=e=>this.pointer(e,"move");
    this.canvas.onpointerup=e=>this.pointer(e,"up");
    this.canvas.onpointercancel=()=>{this.drag=null;};
    $("setupClose").onclick=()=>$("setupDialog").close();
    $("setupCancel").onclick=()=>$("setupDialog").close();
    $("setupMode").onchange=()=>{this.mode=$("setupMode").value;this.draw();};
    $("anchorSelect").replaceChildren(...names.map((n,i)=>new Option(`${i+1}. ${n}`,i)));
    $("anchorSelect").onchange=()=>{this.selected=Number($("anchorSelect").value);this.draw();};
    $("setupCanvas").onkeydown=e=>{
      const d={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];
      if(!d||this.mode!=="court")return;e.preventDefault();const p=this.profile.anchors[this.selected],step=e.shiftKey?10:1;
      p[0]=Math.max(0,Math.min(1920,p[0]+d[0]*step));p[1]=Math.max(0,Math.min(1080,p[1]+d[1]*step));this.draw();this.rectify();
    };
    $("setupReset").onclick=()=>{this.profile.anchors=structuredClone(this.defaults);this.draw();this.rectify();};
    for(const team of ["home","away"])$(team+"Clear").onclick=()=>{this.profile.palettes[team]=[];this.swatches();};
    $("setupApply").onclick=async()=>{
      if(!validCalibration(this.profile.anchors)){this.note("코트가 접히거나 교차합니다. 기준점을 다시 조정하세요.");return;}
      $("setupApply").disabled=true;
      try{await this.onApply(structuredClone(this.profile));$("setupDialog").close();}
      catch(e){this.note(e.message);}finally{$("setupApply").disabled=false;}
    };
  }
  async open(clip,scene){
    this.pixels=null;this.profile=structuredClone(scene.setup);this.defaults=structuredClone(scene.calibration.anchors);
    this.boxes=scene.frames[0]?.boxes||[];this.mode="court";this.selected=0;this.drag=null;
    $("setupMode").value="court";$("anchorSelect").value="0";$("setupTitle").textContent=`${clip.game} · 첫 프레임`;
    $("setupApply").disabled=true;$("setupDialog").showModal();this.note("원본 첫 프레임을 불러오는 중…");
    try{
      const img=new Image();img.src=`/frames/${clip.id}.png`;await img.decode();
      this.sourceCtx.drawImage(img,0,0,1920,1080);this.pixels=this.sourceCtx.getImageData(0,0,1920,1080);
      this.swatches();this.draw();this.rectify();$("setupApply").disabled=false;
      this.note("모서리 4개를 맞춘 뒤 경계 중앙점을 휘어진 선 위로 옮기세요. 마지막으로 코트 중심을 맞춥니다.");
    }catch(e){this.note(`첫 프레임을 열지 못했습니다: ${e.message}`);}
  }
  note(text){$("setupNote").textContent=text;}
  point(e){const r=this.canvas.getBoundingClientRect();return [(e.clientX-r.left)*1920/r.width,(e.clientY-r.top)*1080/r.height];}
  pointer(e,kind){
    if(!this.pixels)return;const p=this.point(e);
    if(kind==="down"){
      this.canvas.setPointerCapture(e.pointerId);
      if(this.mode!=="court"){
        const rgb=samplePatch(this.sourceCtx,...p,1920,1080),palette=this.profile.palettes[this.mode];
        if(palette.length>=8)palette.shift();palette.push(rgb);this.swatches();
        this.note(`${this.mode==="home"?"홈":"어웨이"} ${hex(rgb)} 추가 · 마지막 샘플이 3D 유니폼 색상에 반영됩니다.`);
      }else{
        const nearest=this.profile.anchors.map((a,i)=>({i,d:Math.hypot(a[0]-p[0],a[1]-p[1])})).sort((a,b)=>a.d-b.d)[0];
        if(nearest.d<36){this.selected=nearest.i;this.drag=nearest.i;$("anchorSelect").value=String(this.selected);}
        else{this.profile.anchors[this.selected]=p;this.rectify();}
      }
    }
    if(kind==="move"){
      if(this.drag!=null)this.profile.anchors[this.drag]=p.map((v,i)=>Math.max(0,Math.min(i?1080:1920,v)));
      const zoom=$("setupZoom").getContext("2d");zoom.imageSmoothingEnabled=false;zoom.clearRect(0,0,160,100);
      zoom.drawImage(this.source,p[0]-32,p[1]-20,64,40,0,0,160,100);zoom.strokeStyle="#f5bf72";zoom.strokeRect(74,44,12,12);
    }
    if(kind==="up"){this.drag=null;this.rectify();}
    this.draw();
  }
  swatches(){
    for(const team of ["home","away"]){
      const el=$(team+"Swatches");el.replaceChildren();
      this.profile.palettes[team].forEach((rgb,i)=>{
        const b=document.createElement("button");b.style.background=hex(rgb);b.title=`${hex(rgb)} · 클릭하여 제거`;
        b.setAttribute("aria-label",`${team==="home"?"홈":"어웨이"} 색상 ${hex(rgb)} 제거`);
        b.onclick=()=>{this.profile.palettes[team].splice(i,1);this.swatches();};el.append(b);
      });
      if(!el.children.length)el.textContent="스포이드로 유니폼을 클릭하세요.";
    }
  }
  draw(){
    const ctx=this.ctx,a=this.profile.anchors;ctx.clearRect(0,0,1920,1080);ctx.drawImage(this.source,0,0);
    const path=new Path2D();path.rect(0,0,1920,1080);
    const edge=[];for(let x=0;x<=28;x+=.5)edge.push(courtToImage(x,0,a));
    for(let y=0;y<=15;y+=.25)edge.push(courtToImage(28,y,a));
    for(let x=28;x>=0;x-=.5)edge.push(courtToImage(x,15,a));
    for(let y=15;y>=0;y-=.25)edge.push(courtToImage(0,y,a));
    path.moveTo(...edge[0]);edge.forEach(p=>path.lineTo(...p));path.closePath();
    ctx.fillStyle="#0c1119b8";ctx.fill(path,"evenodd");ctx.lineWidth=3;ctx.strokeStyle="#ffbd71";
    ctx.beginPath();edge.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));ctx.closePath();ctx.stroke();
    for(const axis of ["x","y"])for(let v=0;v<=(axis==="x"?28:15);v+=axis==="x"?7:3.75){
      ctx.beginPath();for(let k=0;k<=60;k++){const q=k/60*(axis==="x"?15:28),p=courtToImage(axis==="x"?v:q,axis==="x"?q:v,a);k?ctx.lineTo(...p):ctx.moveTo(...p);}ctx.strokeStyle="#ffcf8880";ctx.lineWidth=1.5;ctx.stroke();
    }
    let inside=0;
    for(const b of this.boxes){
      const p=[(b.box[0]+b.box[2])*960,b.box[3]*1080],c=imageToCourt(...p,a),ok=c&&c.x>=0&&c.x<=28&&c.y>=0&&c.y<=15;
      if(ok)inside++;ctx.fillStyle=ok?"#b1f1cf":"#e77e7b";ctx.beginPath();ctx.arc(...p,4,0,Math.PI*2);ctx.fill();
    }
    a.forEach((p,i)=>{
      ctx.fillStyle=i===this.selected?"#ffffff":"#edaa62";ctx.strokeStyle="#38291c";ctx.lineWidth=3;
      ctx.beginPath();ctx.arc(...p,i===this.selected?17:13,0,Math.PI*2);ctx.fill();ctx.stroke();
      ctx.fillStyle="#2c241d";ctx.font='700 17px "KBL Jump", sans-serif' ;ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText(i+1,...p);
    });
    $("roiCount").textContent=`첫 프레임 추적 결과: 경계 안 ${inside} / 밖 ${this.boxes.length-inside} · 적용 시 원본 검출을 다시 필터링`;
    $("setupCanvas").style.cursor=this.mode==="court"?"grab":"crosshair";
  }
  rectify(){
    const c=$("rectified"),ctx=c.getContext("2d");
    if(!validCalibration(this.profile.anchors)){ctx.clearRect(0,0,c.width,c.height);this.note("경계가 접히거나 교차합니다. 기준점 위치를 확인하세요.");return;}
    const out=ctx.createImageData(c.width,c.height),src=this.pixels.data;
    for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){
      const p=courtToImage(x/(c.width-1)*28,y/(c.height-1)*15,this.profile.anchors);
      const sx=Math.round(p[0]),sy=Math.round(p[1]),i=(y*c.width+x)*4,j=(sy*1920+sx)*4;
      if(sx>=0&&sx<1920&&sy>=0&&sy<1080){out.data[i]=src[j];out.data[i+1]=src[j+1];out.data[i+2]=src[j+2];}
      out.data[i+3]=255;
    }ctx.putImageData(out,0,0);
  }
}
