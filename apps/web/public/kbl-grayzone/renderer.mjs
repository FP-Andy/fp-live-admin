import * as THREE from "three";
import {OrbitControls} from "three/addons/controls/OrbitControls.js";
import {humanMesh,humanSpec,eyePosition} from "./mesh-human.mjs";

export const COLORS = {player:"#bcc9d4",unknown:"#8d9eac",home:"#8f3235",away:"#e9e6dc",refA:"#e4ad69",refB:"#e4ad69",refC:"#e4ad69",target:"#b6efd0"};
import {courtLines,loadCourtAsset} from './court-asset.mjs';
export {courtLines} from './court-asset.mjs';
const world = p => new THREE.Vector3(p.x,p.z||0,p.y);

export class CourtRenderer {
  constructor(container,onSelect){
    this.container=container;this.onSelect=onSelect;this.mode="broadcast";this.meshGeometries=new Map();
    this.scene=new THREE.Scene();this.scene.background=new THREE.Color("#f5f6f8");
    this.camera=new THREE.PerspectiveCamera(43,16/9,.02,250);
    this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,powerPreference:'low-power'});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,1.25));this.renderer.outputColorSpace=THREE.SRGBColorSpace;
    this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.12;
    container.prepend(this.renderer.domElement);
    this.controls=new OrbitControls(this.camera,this.renderer.domElement);
    this.controls.enableDamping=false;this.controls.maxPolarAngle=Math.PI/2-.04;this.controls.minDistance=3;this.controls.maxDistance=80;
    this.controls.addEventListener("change",()=>this.draw());
    this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    this.scene.add(new THREE.HemisphereLight(0xfff8ed,0x6f6b67,1.35));
    const sun=new THREE.DirectionalLight(0xfff0dd,3.1);sun.position.set(6,19,9);sun.castShadow=true;
    sun.shadow.mapSize.set(1024,1024);Object.assign(sun.shadow.camera,{left:-19,right:19,top:13,bottom:-13,near:1,far:45});
    sun.shadow.bias=-.00015;sun.shadow.normalBias=.018;sun.shadow.radius=4;sun.shadow.blurSamples=8;
    sun.target.position.set(14,0,7.5);this.scene.add(sun,sun.target);
    const fill=new THREE.DirectionalLight(0xe8efff,1.05);fill.position.set(28,12,-5);fill.target.position.set(14,0,7.5);this.scene.add(fill,fill.target);
    const rim=new THREE.DirectionalLight(0xffffff,.85);rim.position.set(4,9,-10);rim.target.position.set(14,0,7.5);this.scene.add(rim,rim.target);
    const ground=new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.MeshStandardMaterial({color:0xf1f0ed,roughness:1}));
    ground.rotation.x=-Math.PI/2;ground.position.set(14,-.008,7.5);this.scene.add(ground);
    const base=new THREE.Mesh(new THREE.BoxGeometry(28.16,.16,15.16),new THREE.MeshStandardMaterial({color:0xa65b30,roughness:.65}));
    base.position.set(14,-.085,7.5);base.receiveShadow=true;this.scene.add(base);
    const c=document.createElement("canvas");c.width=1680;c.height=900;const ctx=c.getContext("2d");
    const grain=document.createElement("canvas");grain.width=1680;grain.height=900;const gx=grain.getContext("2d");
    ctx.fillStyle="#d6965b";ctx.fillRect(0,0,c.width,c.height);gx.fillStyle="#ddd";gx.fillRect(0,0,c.width,c.height);
    let seed=215;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
    for(let y=0;y<900;y+=21){
      for(let x=-((y/21)%3)*93;x<1680;x+=280){
        const light=51+random()*5;ctx.fillStyle=`hsl(27 55% ${light}%)`;ctx.fillRect(x,y,279,20.5);
        gx.fillStyle=`rgb(${210+random()*20} 220 220)`;gx.fillRect(x,y,279,20.5);
        for(let i=0;i<12;i++){const gy=y+random()*20;ctx.strokeStyle=`rgba(95,45,12,${.025+random()*.04})`;ctx.lineWidth=.5;ctx.beginPath();ctx.moveTo(x,gy);ctx.bezierCurveTo(x+70,gy-2,x+180,gy+2,x+279,gy);ctx.stroke();}
      }
    }
    courtLines(ctx,c.width,c.height);
    loadCourtAsset().then(()=>{courtLines(ctx,c.width,c.height);texture.needsUpdate=true;this.draw();}).catch(console.error);
    const texture=new THREE.CanvasTexture(c);texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=Math.min(4,this.renderer.capabilities.getMaxAnisotropy());
    const roughness=new THREE.CanvasTexture(grain);roughness.anisotropy=texture.anisotropy;
    const floor=new THREE.Mesh(new THREE.PlaneGeometry(28,15),new THREE.MeshPhysicalMaterial({map:texture,roughness:.84,roughnessMap:roughness,clearcoat:.07,clearcoatRoughness:.6,bumpMap:roughness,bumpScale:.0006}));
    floor.rotation.x=-Math.PI/2;floor.position.set(14,0,7.5);this.scene.add(floor);
    floor.receiveShadow=true;ground.receiveShadow=true;
    // Keep the supplied CI intact, including its native aspect ratio and colors.
    const ci=new Image();ci.onload=()=>{
      const width=114,height=width*953.1/1580.2;
      ctx.drawImage(ci,840-width/2,450-height/2,width,height);
      texture.needsUpdate=true;this.draw();
    };ci.src=new URL("./assets/kbl-ci.svg",import.meta.url).href;
    const ballCanvas=document.createElement("canvas");ballCanvas.width=512;ballCanvas.height=256;
    const bc=ballCanvas.getContext("2d");bc.fillStyle="#d87826";bc.fillRect(0,0,512,256);
    for(let i=0;i<4500;i++){const x=(i*83)%512,y=(i*47+Math.floor(i/11)*17)%256;bc.fillStyle=i%2?"#f2a05255":"#7b3d1c55";bc.fillRect(x,y,1.1,1.1);}
    bc.strokeStyle="#3e281e";bc.lineWidth=5;
    bc.beginPath();bc.moveTo(0,128);bc.lineTo(512,128);bc.stroke();
    for(let k=0;k<4;k++){bc.beginPath();for(let y=0;y<=256;y++){const x=k*128+32*Math.sin(y/256*Math.PI*2);y?bc.lineTo(x,y):bc.moveTo(x,y);}bc.stroke();}
    const ballTexture=new THREE.CanvasTexture(ballCanvas);ballTexture.colorSpace=THREE.SRGBColorSpace;
    this.ball=new THREE.Mesh(new THREE.SphereGeometry(.12,32,24),new THREE.MeshStandardMaterial({map:ballTexture,roughness:.82}));
    this.ball.castShadow=true;this.ball.visible=false;this.scene.add(this.ball);
    for(const rotation of [[0,0,0],[Math.PI/2,0,0],[0,Math.PI/2,0]]){
      const seam=new THREE.Mesh(new THREE.TorusGeometry(.1203,.0026,6,64),new THREE.MeshStandardMaterial({color:0x33251d,roughness:1}));
      seam.rotation.set(...rotation);this.ball.add(seam);
    }
    this.ballLabel=this.label("BALL","#f4b36f");this.ballLabel.visible=false;this.scene.add(this.ballLabel);
    this.ballTrail=new THREE.Line(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({color:0xf4b36f,transparent:true,opacity:.7}));this.scene.add(this.ballTrail);
    this.people=new Map();this.lines=new THREE.Group();this.scene.add(this.lines);
    this.target=new THREE.Mesh(new THREE.SphereGeometry(.15,16,12),new THREE.MeshBasicMaterial({color:0xa5ebc6}));
    this.scene.add(this.target);
    this.targetRing=new THREE.Mesh(new THREE.RingGeometry(.45,.49,32),new THREE.MeshBasicMaterial({color:0xa5ebc6,side:THREE.DoubleSide}));
    this.targetRing.rotation.x=-Math.PI/2;this.scene.add(this.targetRing);
    this.raycaster=new THREE.Raycaster();this.pointer=new THREE.Vector2();
    let down;
    this.renderer.domElement.addEventListener("pointerdown",e=>{down=[e.clientX,e.clientY];});
    this.renderer.domElement.addEventListener("pointerup",e=>{
      if(!down||Math.hypot(e.clientX-down[0],e.clientY-down[1])>5)return;
      const r=this.renderer.domElement.getBoundingClientRect();
      this.pointer.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);
      this.raycaster.setFromCamera(this.pointer,this.camera);
      const hits=this.raycaster.intersectObjects([...this.people.values()].flatMap(g=>g.userData.pickMeshes));
      if(hits[0])this.onSelect(hits[0].object.userData.id);
    });
    new ResizeObserver(()=>this.resize()).observe(container);this.setMode("broadcast");this.resize();
  }
  label(text,color){
    const c=document.createElement("canvas");c.width=128;c.height=48;const x=c.getContext("2d");
    x.fillStyle="#152027dd";x.beginPath();x.roundRect(8,5,112,38,10);x.fill();
    x.font='700 23px "KBL Jump", sans-serif';x.fillStyle=color;x.textAlign="center";x.fillText(text,64,32);
    const texture=new THREE.CanvasTexture(c);texture.colorSpace=THREE.SRGBColorSpace;
    const s=new THREE.Sprite(new THREE.SpriteMaterial({map:texture,depthTest:true,transparent:true}));
    s.scale.set(1.05,.39,1);return s;
  }
  setMode(mode){
    this.mode=mode;this.controls.enabled=mode!=="eye"&&mode!=="ball";
    if(mode==="broadcast"){this.camera.up.set(0,1,0);this.camera.position.set(14,24,30);this.controls.target.set(14,0,7.5);}
    if(mode==="top"){this.camera.up.set(0,0,-1);this.camera.position.set(14,36,7.5+.001);this.controls.target.set(14,0,7.5);}
    if(mode!=="eye"){this.camera.fov=43;this.camera.aspect=this.container.clientWidth/this.container.clientHeight;this.camera.updateProjectionMatrix();this.controls.update();}
    this.draw();
  }
  resize(){
    const w=this.container.clientWidth,h=this.container.clientHeight;
    if(!w||!h)return;
    this.renderer.setSize(w,h,false);
    if(this.mode!=="eye"){this.camera.aspect=w/h;this.camera.updateProjectionMatrix();}
    this.draw();
  }
  disposeGroup(group){
    group.traverse(o=>{
      if(!o.userData.sharedGeometry)o.geometry?.dispose();
      for(const m of (Array.isArray(o.material)?o.material:o.material?[o.material]:[])){m.map?.dispose();m.dispose();}
    });
  }
  geometryFor(e,config){
    const spec=humanSpec(e,config);if(this.meshGeometries.has(spec.key))return this.meshGeometries.get(spec.key);
    const data=humanMesh(e,config),geometry=new THREE.BufferGeometry(),positions=new Float32Array(data.positions.length),indices=[];
    for(let i=0;i<positions.length;i+=3){positions[i]=data.positions[i];positions[i+1]=data.positions[i+2];positions[i+2]=data.positions[i+1];}
    data.parts.forEach((p,m)=>{const start=indices.length;for(let i=0;i<p.indices.length;i+=3)indices.push(p.indices[i],p.indices[i+2],p.indices[i+1]);geometry.addGroup(start,p.indices.length,m);});
    geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));geometry.setIndex(indices);geometry.computeVertexNormals();geometry.computeBoundingSphere();
    this.meshGeometries.set(spec.key,geometry);return geometry;
  }
  update(entities,target,observer,result,config,showRays,movedId,ball=null){
    this.state={entities,target,observer,result,config,showRays,movedId};
    const seen=new Set(entities.map(e=>e.id));
    for(const [id,g] of this.people)if(!seen.has(id)){this.scene.remove(g);this.disposeGroup(g);this.people.delete(id);}
    for(const e of entities){
      const referee=e.role.startsWith("ref"),color=e.color||COLORS[e.team]||COLORS[e.role]||COLORS.unknown;
      let g=this.people.get(e.id);
      if(e.positionOnly){
        if(g&&(g.userData.key!=='position-only'||g.userData.color!==color||g.userData.label!==e.label)){this.scene.remove(g);this.disposeGroup(g);this.people.delete(e.id);g=null;}
        if(!g){
          g=new THREE.Group();const marker=new THREE.Mesh(new THREE.SphereGeometry(.19,16,12),new THREE.MeshBasicMaterial({color}));marker.position.y=.2;marker.userData={id:e.id};g.add(marker);
          const ring=new THREE.Mesh(new THREE.RingGeometry(.29,.34,32),new THREE.MeshBasicMaterial({color,side:THREE.DoubleSide,transparent:true,opacity:.7}));ring.rotation.x=-Math.PI/2;ring.position.y=.012;g.add(ring);
          const label=this.label((e.label||String(e.id))+' · 위치만',color);label.position.y=.6;g.add(label);
          g.userData={key:'position-only',color,label:e.label,labelSprite:label,ring,pickMeshes:[marker]};this.scene.add(g);this.people.set(e.id,g);
        }
        g.position.set(e.x,0,e.y);g.userData.labelSprite.visible=config.showLabels!==false;g.visible=this.mode!=="eye";continue;
      }
      const spec=humanSpec(e,config);
      if(g&&(g.userData.key!==spec.key||g.userData.color!==color||g.userData.label!==e.label)){
        this.scene.remove(g);this.disposeGroup(g);this.people.delete(e.id);g=null;
      }
      if(!g){
        g=new THREE.Group();const data=humanMesh(e,config);
        const colors={jersey:referee?'#b9bec7':color,shorts:referee?'#20242c':new THREE.Color(color).multiplyScalar(.78),trim:referee?'#232732':'#f3f0e7',skin:'#81929f',hair:'#81929f',shoes:referee?'#242832':'#e8e7e2',sole:'#c2c3c5',eyes:'#81929f',iris:'#81929f'};
        const materials=data.parts.map(p=>new THREE.MeshStandardMaterial({color:colors[p.material],roughness:p.material==='skin'?.75:.91,side:THREE.DoubleSide}));
        const body=new THREE.Mesh(this.geometryFor(e,config),materials);body.castShadow=true;body.receiveShadow=true;body.userData={id:e.id,sharedGeometry:true};g.add(body);
        const ring=new THREE.Mesh(new THREE.RingGeometry(.35,.39,40),new THREE.MeshBasicMaterial({color,side:THREE.DoubleSide,transparent:true,opacity:.65}));
        ring.rotation.x=-Math.PI/2;ring.position.y=.012;g.add(ring);
        const label=this.label(e.label||String(e.id),referee?'#ffd0a1':color);g.add(label);
        g.userData={body,pickMeshes:[body],key:spec.key,color,label:e.label,ring,labelSprite:label};this.scene.add(g);this.people.set(e.id,g);
      }
      g.rotation.y=-spec.heading;g.userData.body.scale.set(spec.widthScale,spec.heightScale,spec.widthScale);
      g.userData.ring.scale.setScalar(spec.widthScale);g.userData.labelSprite.position.y=spec.height+.27;
      g.userData.labelSprite.visible=config.showLabels!==false&&(config.labelMode==='referees'?referee||e.id===target?.entityId:config.labelMode!=='selected'||e.id===observer?.id||e.id===target?.entityId);
      g.userData.ring.material.color.set(e.id===target?.entityId?COLORS.target:color);
      g.position.set(e.x,0,e.y);g.visible=!(this.mode==="eye"&&observer?.id===e.id);
    }
    const usedGeometry=new Set([...this.people.values()].map(g=>g.userData.key));
    for(const [key,geometry] of this.meshGeometries)if(!usedGeometry.has(key)){geometry.dispose();this.meshGeometries.delete(key);}
    this.ball.visible=!!ball;this.ballLabel.visible=!!ball;
    if(ball){
      this.ball.position.copy(world(ball));this.ball.rotation.set(ball.t*2.7,ball.t*1.7,0);
      this.ball.material.transparent=ball.source!=="detected"&&ball.source!=="manual";this.ball.material.opacity=this.ball.material.transparent ? .68 :1;
      this.ball.children.forEach(s=>{s.material.transparent=this.ball.material.transparent;s.material.opacity=this.ball.material.opacity;});
      this.ballLabel.position.set(ball.x,ball.z+.45,ball.y);
    }
    this.ballTrail.geometry.dispose();this.ballTrail.geometry=new THREE.BufferGeometry().setFromPoints((ball?.trail||[]).map(world));
    while(this.lines.children.length){const l=this.lines.children[0];this.lines.remove(l);this.disposeGroup(l);}
    if(target){
      this.target.visible=target.kind!=="ball";this.target.position.copy(world(target));
      this.targetRing.visible=true;this.targetRing.position.set(target.x,.025,target.y);
    }else{this.target.visible=false;this.targetRing.visible=false;}
    if(showRays&&result&&this.mode!=="eye"){
      for(const ray of result.rays){
        const color=ray.state==="visible"?0xa5ebc6:ray.state==="blocked"?0xeb8c7b:0x647983;
        const points=[world(ray.eye),world(ray.hit||ray.end)];
        const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),new THREE.LineBasicMaterial({color,transparent:true,opacity:.65}));
        this.lines.add(line);
      }
    }
    if(this.mode==='scene'&&entities.length){
      // Fit the standing bounds of every placed person, including sideline referees.
      const points=entities.flatMap(e=>[-.65,.65].flatMap(dx=>[-.65,.65].flatMap(dz=>[0,2.7].map(h=>new THREE.Vector3(e.x+dx,h,e.y+dz)))));
      const center=new THREE.Box3().setFromPoints(points).getCenter(new THREE.Vector3());
      const offset=new THREE.Vector3(.6,.9,1).normalize(),right=new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0),offset).normalize(),up=new THREE.Vector3().crossVectors(offset,right);
      const ty=Math.tan(this.camera.fov*Math.PI/360),tx=ty*this.camera.aspect;
      const distance=1.1*Math.max(5,...points.map(point=>{const v=point.clone().sub(center);return v.dot(offset)+Math.max(Math.abs(v.dot(right))/tx,Math.abs(v.dot(up))/ty);}));
      this.camera.up.set(0,1,0);this.camera.position.copy(center).addScaledVector(offset,distance);this.controls.target.copy(center);this.controls.update();
    }
    if(this.mode==='detail'){
      const focus=target&&!target.missing&&(target.entityId||target.kind==='ball')?target:observer||entities[0]||{x:14,y:7.5};
      this.camera.up.set(0,1,0);this.camera.position.set(focus.x+3.3,3.1,focus.y+4.2);this.controls.target.set(focus.x,1.05,focus.y);this.controls.update();
    }
    if(this.mode==="ball"&&ball){
      this.camera.up.set(0,1,0);this.camera.position.set(ball.x+3.5,ball.z+2.7,ball.y+4.5);
      this.camera.lookAt(ball.x,ball.z,ball.y);this.camera.fov=38;this.camera.aspect=this.container.clientWidth/this.container.clientHeight;this.camera.updateProjectionMatrix();
    }
    if(this.mode==="eye"&&observer&&Number.isFinite(observer.heading)){
      this.camera.up.set(0,1,0);const eye=eyePosition(observer,config),ez=eye.z;this.camera.position.set(eye.x,ez,eye.y);
      this.camera.lookAt(eye.x+Math.cos(observer.heading)*10,ez,eye.y+Math.sin(observer.heading)*10);
      this.camera.fov=config.vfov;
      this.camera.aspect=Math.tan(config.hfov*Math.PI/360)/Math.tan(config.vfov*Math.PI/360);
      this.camera.updateProjectionMatrix();
    }
    this.draw();
  }
  capture(scale=1){
    const ratio=this.renderer.getPixelRatio();
    try{if(scale>1)this.renderer.setPixelRatio(Math.min(ratio*scale,2));this.draw();return this.renderer.domElement.toDataURL("image/jpeg",.95);}
    finally{if(scale>1){this.renderer.setPixelRatio(ratio);this.draw();}}
  }
  draw(){
    if(!this.renderer)return;
    const w=this.container.clientWidth,h=this.container.clientHeight;
    this.renderer.setViewport(0,0,w,h);this.renderer.clear();
    if(this.mode==="eye"){
      if(!this.state?.observer || !Number.isFinite(this.state.observer.heading))return;
      const aspect=this.camera.aspect,vw=Math.min(w,h*aspect),vh=vw/aspect;
      this.renderer.setViewport((w-vw)/2,(h-vh)/2,vw,vh);
    }
    this.renderer.render(this.scene,this.camera);
  }
}
