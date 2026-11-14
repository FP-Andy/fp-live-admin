import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {humanMesh} from './mesh-human.mjs';
import {DEFAULTS} from './geometry.mjs';
const world=a=>new THREE.Vector3(a[0],a[2],a[1]),local=v=>[v.x,v.z,v.y];
export class ArmEditor3D{
 constructor(container,onPoint,onSelect){
  this.container=container;this.onPoint=onPoint;this.onSelect=onSelect;
  this.scene=new THREE.Scene();this.scene.background=new THREE.Color('#f4f6f9');this.camera=new THREE.PerspectiveCamera(38,1,.02,30);
  this.renderer=new THREE.WebGLRenderer({antialias:true});this.renderer.setPixelRatio(Math.min(devicePixelRatio,2));this.renderer.outputColorSpace=THREE.SRGBColorSpace;container.append(this.renderer.domElement);this.renderer.domElement.setAttribute('aria-label','3D 팔꿈치 손목 보정');
  this.scene.add(new THREE.HemisphereLight(0xffffff,0x697786,2.4));const light=new THREE.DirectionalLight(0xffffff,2.3);light.position.set(3,5,4);this.scene.add(light);
  this.scene.add(new THREE.GridHelper(3,12,0xa4adba,0xdce1e9));this.content=new THREE.Group();this.scene.add(this.content);this.handles=new THREE.Group();this.scene.add(this.handles);
  this.ray=new THREE.Raycaster();this.pointer=new THREE.Vector2();const canvas=this.renderer.domElement;
  const ray=e=>{const r=canvas.getBoundingClientRect();this.pointer.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);this.ray.setFromCamera(this.pointer,this.camera);};
  canvas.addEventListener('pointerdown',e=>{if(this.disabled)return;ray(e);const hit=this.ray.intersectObjects(this.handles.children.filter(o=>o.userData.joint))[0];if(!hit)return;e.stopImmediatePropagation();this.dragging=hit.object.userData.joint;this.onSelect(this.dragging);this.plane=new THREE.Plane().setFromNormalAndCoplanarPoint(this.camera.getWorldDirection(new THREE.Vector3()),hit.object.position);this.controls.enabled=false;canvas.setPointerCapture(e.pointerId);},true);
  canvas.addEventListener('pointermove',e=>{if(!this.dragging)return;ray(e);const q=this.ray.ray.intersectPlane(this.plane,new THREE.Vector3());if(q)this.onPoint(this.dragging,local(q).map((v,i)=>v-this.rig.shoulder[i]));});
  const up=()=>{this.dragging=null;this.controls.enabled=true;};canvas.addEventListener('pointerup',up);canvas.addEventListener('pointercancel',up);
  this.controls=new OrbitControls(this.camera,canvas);this.controls.target.set(0,1.1,0);this.controls.minDistance=1.8;this.controls.maxDistance=7;this.controls.addEventListener('change',()=>this.draw());this.view('perspective');
  this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(container);
 }
 clear(group){while(group.children.length){const o=group.children[0];group.remove(o);o.geometry?.dispose();for(const m of (Array.isArray(o.material)?o.material:[o.material]))m?.dispose();}}
 person(p){this.personData=p;this.clear(this.content);const data=humanMesh({role:p.role,meshKey:p.meshKey},DEFAULTS),g=new THREE.BufferGeometry(),pos=[];for(let i=0;i<data.positions.length;i+=3)pos.push(data.positions[i],data.positions[i+2],data.positions[i+1]);const indices=[];data.parts.forEach((part,i)=>{const start=indices.length;for(let j=0;j<part.indices.length;j+=3)indices.push(part.indices[j],part.indices[j+2],part.indices[j+1]);g.addGroup(start,part.indices.length,i);});g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setIndex(indices);g.computeVertexNormals();const colors={skin:'#81929f',jersey:p.role.startsWith('ref')?'#aeb6c0':p.team==='home'?'#23354e':'#e6e9ed',shorts:'#253449',shoes:'#e0e4e8'};
  const mats=data.parts.map(x=>new THREE.MeshStandardMaterial({color:colors[x.material]||'#c8ccd2',roughness:.8,side:THREE.DoubleSide,transparent:true}));this.body=new THREE.Mesh(g,mats);this.body.rotation.y=p.meshBodyHeading??p.bodyHeading??0;this.content.add(this.body);this.resize();}
 update(rig,target,joint,dirty){this.rig=rig;this.clear(this.handles);const pts=[rig.shoulder,...['elbow','wrist'].map(k=>target[k].map((v,i)=>v+rig.shoulder[i]))];const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts.map(world)),new THREE.LineBasicMaterial({color:dirty?0xf36b29:0x14b99f,depthTest:false}));line.renderOrder=2;this.handles.add(line);
  pts.forEach((p,i)=>{const key=['shoulder','elbow','wrist'][i],m=new THREE.Mesh(new THREE.SphereGeometry(key===joint ? .057 : .043,18,12),new THREE.MeshBasicMaterial({color:key===joint?0xff6d22:i?0x16bfa6:0xffffff,depthTest:false}));m.position.copy(world(p));m.userData.joint=i?key:null;m.renderOrder=3;this.handles.add(m);});for(const m of this.body?.material||[])m.opacity=dirty ? .4 : 1;this.draw();}
 view(mode){this.camera.up.set(0,1,0);this.camera.position.copy(mode==='front'?new THREE.Vector3(4,1.25,0):mode==='side'?new THREE.Vector3(0,1.25,4):new THREE.Vector3(3.1,2.1,3.1));this.controls?.update();this.draw();}
 resize(){const w=this.container.clientWidth,h=this.container.clientHeight;if(!w||!h)return;this.renderer.setSize(w,h,false);this.camera.aspect=w/h;this.camera.updateProjectionMatrix();this.draw();}
 draw(){this.renderer.render(this.scene,this.camera);}
}
