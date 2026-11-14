"""Offline asset build: Blender 4.5 LTS + MPFB 2.0.18 core assets (CC0).
Run from repo root with Blender --background --factory-startup --python this_file.
The exported triangles are shared by WebGL rendering and CPU BVH occlusion.
"""
from pathlib import Path
import sys, json, math, hashlib
import bpy, bmesh
from mathutils import Vector, Matrix
ROOT=Path.cwd(); WORK=ROOT/'runtime/kbl-mpfb'; OUT=ROOT/'apps/web/public/kbl-grayzone/assets/humans'
OUT.mkdir(parents=True,exist_ok=True)
sys.path.insert(0,str(WORK/'mpfb2-master/src'))
bpy.utils.extension_path_user=lambda *a,**kw:str(WORK/'user')
import mpfb
bpy.context.preferences.addons.new().module='mpfb'; mpfb.register()
from mpfb.services.humanservice import HumanService
from mpfb.services.targetservice import TargetService
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
macro=TargetService.get_default_macro_info_dict();macro.update(gender=1.,age=.5,muscle=.65,weight=.45)
h=HumanService.create_human(macro_detail_dict=macro)
rig=HumanService.add_builtin_rig(h,'game_engine')
for m in h.modifiers:
    if m.type=='MASK':m.show_viewport=False;m.show_render=False
bpy.context.view_layer.update()
def evaluated():
    e=h.evaluated_get(bpy.context.evaluated_depsgraph_get());m=e.to_mesh()
    v=[p.co.copy() for p in m.vertices];n=[p.normal.copy() for p in m.vertices];e.to_mesh_clear();return v,n
rest,_=evaluated()
def ids(name):
    g=h.vertex_groups[name].index
    return {v.index for v in h.data.vertices if any(x.group==g for x in v.groups)}
groups={k:ids(k) for k in ['body','helper-tights','helper-hair','helper-l-eye','helper-r-eye']}
bodyz=[rest[i].z for i in groups['body']];zmin=min(bodyz);height=max(bodyz)-zmin
scale=1.9/height
rest=[Vector((v.x*scale,v.y*scale,(v.z-zmin)*scale)) for v in rest]
faces=[list(p.vertices) for p in h.data.polygons]
rest_matrices={b.name:b.matrix_basis.copy() for b in rig.pose.bones}
materials=['skin','jersey','shorts','trim','hair','shoes','sole','eyes','iris']
colors={'skin':(.56,.33,.21,1),'jersey':(.72,.12,.06,1),'shorts':(.72,.12,.06,1),'trim':(.95,.92,.86,1),'hair':(.035,.026,.023,1),'shoes':(.08,.09,.11,1),'sole':(.8,.8,.76,1),'eyes':(.8,.76,.68,1),'iris':(.025,.018,.012,1)}
for name in materials:
    m=bpy.data.materials.new(name);m.diffuse_color=colors[name]

def garment(p,role):
    x,y,z=p
    if .98<z<1.62 and abs(x)<(.235 if role=='player' else .37):return 'jersey'
    if (.62 if role=='player' else .15)<z<=1.015 and abs(x)<.29:return 'shorts'
    return None

def set_pose(pose):
    for b in rig.pose.bones:b.matrix_basis=rest_matrices[b.name]
    bpy.context.view_layer.update()
    for side,s in [('l',1),('r',-1)]:
        dirs=([(s*.10,-.02,-.30),(s*.025,-.075,-.27)] if pose=='neutral' else [(s*.30,0,-.075),(s*.27,-.055,.035)])
        for name,d in zip(['upperarm_','lowerarm_'],dirs):
            b=rig.pose.bones[name+side];head=b.head.copy();rot=(b.tail-head).rotation_difference(Vector(d))
            b.matrix=Matrix.Translation(head)@rot.to_matrix().to_4x4()@Matrix.Translation(-head)@b.matrix
            bpy.context.view_layer.update()

def build(role,pose):
    set_pose(pose);v,n=evaluated();v=[Vector((p.x*scale,p.y*scale,(p.z-zmin)*scale)) for p in v]
    verts=[];polys=[];mats=[];lookup={}
    def addface(f,mat,layer,inflate=0):
        out=[]
        for i in f:
            key=(i,layer)
            if key not in lookup:
                p=v[i]+n[i]*inflate;lookup[key]=len(verts);verts.append(tuple(p))
            out.append(lookup[key])
        polys.append(out);mats.append(materials.index(mat))
    for f in faces:
        c=sum((rest[i] for i in f),Vector())/len(f)
        if all(i in groups['body'] for i in f):
            # Keep skin under the opaque clothing so neckline/hem gaps stay anatomical.
            mat='skin'
            if c.z<.135:mat='shoes' if c.z>.035 else 'sole'
            elif c.z<.24 and role=='player':mat='trim'
            addface(f,mat,'body',.008 if c.z<.135 else 0)
        elif all(i in groups['helper-hair'] for i in f) and min(rest[i].z for i in f)>1.76:addface(f,'hair','hair',.002)
        elif any(all(i in groups[g] for i in f) for g in ['helper-l-eye','helper-r-eye']):addface(f,'eyes','eyes')
    # Cut the tights helper on exact planes before posing; interpolate posed
    # coordinates at new cut vertices. This avoids jagged triangle-selected hems.
    for material,lo,hi,halfwidth in [('jersey',1.015,1.60,.228 if role=='player' else .37),('shorts',.65 if role=='player' else .13,1.035,.29)]:
        bm=bmesh.new(); layers=[bm.verts.layers.float.new('posed_'+str(i)) for i in range(3)];mapping={}
        for f in faces:
            if not all(i in groups['helper-tights'] for i in f):continue
            vs=[]
            for i in f:
                if i not in mapping:
                    q=bm.verts.new(rest[i]);mapping[i]=q;posed=v[i]+n[i]*.022
                    for k in range(3):q[layers[k]]=posed[k]
                vs.append(mapping[i])
            bm.faces.new(vs)
        for point,normal in [((0,0,lo),(0,0,-1)),((0,0,hi),(0,0,1)),((halfwidth,0,0),(1,0,0)),((-halfwidth,0,0),(-1,0,0))]:
            bmesh.ops.bisect_plane(bm,geom=list(bm.verts)+list(bm.edges)+list(bm.faces),dist=1e-7,plane_co=point,plane_no=normal,clear_outer=True,clear_inner=False)
        # Clean boundaries are kept by the later reduction modifier.
        vm={}
        for f in bm.faces:
            out=[]
            for q in f.verts:
                if q not in vm:vm[q]=len(verts);verts.append(tuple(q[l] for l in layers))
                out.append(vm[q])
            polys.append(out)
            center=f.calc_center_median();mat=material
            if role=='referee' and material=='jersey' and abs(center.x)>.215:mat='shorts'
            mats.append(materials.index(mat))
        bm.free()
    mesh=bpy.data.meshes.new(role+'-'+pose);mesh.from_pydata(verts,[],polys);mesh.update()
    obj=bpy.data.objects.new(role+'-'+pose,mesh);bpy.context.collection.objects.link(obj)
    for name in materials:mesh.materials.append(bpy.data.materials[name])
    for p,mi in zip(mesh.polygons,mats):p.material_index=mi;p.use_smooth=True
    bpy.ops.object.select_all(action='DESELECT');obj.select_set(True);bpy.context.view_layer.objects.active=obj
    # A fixed reduced mesh is used for BOTH rendering and intersections; no proxy collider.
    mod=obj.modifiers.new('web reduction','DECIMATE');mod.ratio=.44
    bpy.ops.object.modifier_apply(modifier=mod.name)
    mesh=obj.data;mesh.calc_loop_triangles()
    # Canonical metres: x forward, y across shoulders, z up. Face winding retained.
    positions=[round(c,6) for q in mesh.vertices for c in (-q.co.y,q.co.x,q.co.z)]
    parts=[]
    for mi,name in enumerate(materials):
        indices=[i for tri in mesh.loop_triangles if tri.material_index==mi for i in tri.vertices]
        if indices:parts.append({'material':name,'indices':indices})
    data={'positions':positions,'parts':parts,'triangles':sum(len(p['indices'])//3 for p in parts)}
    obj.hide_render=True;obj.hide_set(True)
    return data
if __name__=='__main__':
    assets={f'{role}-{pose}':build(role,pose) for role in ['player','referee'] for pose in ['neutral','wide']}
    source=json.loads((WORK/'source-commit.json').read_text())['sha']
    result={'schema':'kbl-mpfb-mesh/v1','id':'mpfb-core-20261023-v1','generator':'MPFB 2.0.18 / Blender 4.5.9 LTS','sourceCommit':source,'license':'CC0-1.0','baseHeight':1.9,'baseWidthParameter':.28,'poseMeasured':False,'assets':assets}
    result['geometrySha256']=hashlib.sha256(json.dumps(assets,separators=(',',':')).encode()).hexdigest()
    serialized=json.dumps(result,separators=(',',':'))
    (OUT/'mpfb-court-v1.json').write_text(serialized)
    (WORK/'asset-sha256.txt').write_text(hashlib.sha256(serialized.encode()).hexdigest()+'\n')
    bpy.ops.wm.save_as_mainfile(filepath=str(WORK/'kbl-mpfb-prototype.blend'))
    print('EXPORTED',len(serialized),{k:v['triangles'] for k,v in assets.items()})
