"""Full Step 3 maps for reports, with no export crop or extra target overlay."""
import math
from PIL import Image,ImageDraw

MAP_X=(1280-28*33.5)/2; MAP_Y=90; SCALE=33.5

def star(draw,x,y,r=18):
    points=[(x+math.sin(i*math.pi/5)*r*(1 if i%2==0 else .43),y-math.cos(i*math.pi/5)*r*(1 if i%2==0 else .43)) for i in range(10)]
    draw.polygon(points,fill='#ffbf35',outline='#101633',width=3)

def marked_map(path,snapshot,size,map_layout=None):
    """Contain the whole Step 3 canvas. Never crop, stretch or overpaint it."""
    im=Image.open(path).convert('RGB');state=snapshot['state']
    target=state.get('reviewPoint') or next((e for e in state['entities'] if e['id']==state['targetId']),None)
    factor=min(size[0]/im.width,size[1]/im.height)
    width,height=round(im.width*factor),round(im.height*factor)
    left,top=(size[0]-width)//2,(size[1]-height)//2
    canvas=Image.new('RGB',size,'white')
    canvas.paste(im.resize((width,height),Image.Resampling.LANCZOS),(left,top))
    map_x,map_y,scale=((1280-28*28.5)/2,103,28.5) if (map_layout or snapshot.get('mapLayout'))=='apron-v2' else (MAP_X,MAP_Y,SCALE)
    proof={'method':'full-step3-canvas-contained','crop':[0,0,im.width,im.height],
        'size':list(size),'sourceSize':[im.width,im.height],'displayBounds':[left,top,left+width,top+height],
        'targetId':state['targetId'],'targetXY':[target['x'],target['y']] if target else None,
        'markerPixels':[(map_x+target['x']*scale)*width/im.width+left,(map_y+target['y']*scale)*height/im.height+top] if target else None,
        'positionSource':'manual-map' if state.get('reviewPoint') else 'saved-reconstruction-target',
        'overlayAdded':False}
    return canvas,proof


def prepare_map_presentations(root,case,snapshots):
    """Refresh only presentation, preserving immutable captures and all geometry.

    Old captures contain a filled target marker. Re-drawing the same verified
    scene with the shared Step 3 painter removes it without erasing body pixels.
    All maps in a PDF share one short-lived, CPU-only browser process.
    """
    import hashlib,json,subprocess,tempfile
    from pathlib import Path
    repo=Path(__file__).resolve().parents[2]
    sources=['scripts/kbl_grayzone/render_report_maps.mjs','scripts/kbl_grayzone/report_coverage.mjs',
             'apps/web/public/kbl-grayzone/scene-map.mjs','apps/web/public/kbl-grayzone/crew-analysis.mjs',
             'apps/web/public/kbl-grayzone/geometry.mjs','apps/web/public/kbl-grayzone/mesh-human.mjs',
             'apps/web/public/kbl-grayzone/body-direction.mjs']
    version=hashlib.sha256(b''.join((repo/s).read_bytes() for s in sources)).hexdigest()
    folder=root/'report-map-presentations';folder.mkdir(exist_ok=True)
    jobs=[];paths={}
    for eid,snapshot in snapshots.items():
        signature=hashlib.sha256(json.dumps({'scene':snapshot,'home':case.get('home',''),'away':case.get('away',''),'version':version},sort_keys=True).encode()).hexdigest()[:24]
        output=folder/(signature+'.png');paths[eid]=output
        if not output.exists():jobs.append({'snapshot':snapshot,'home':case.get('home',''),'away':case.get('away',''),'output':str(output)})
    if jobs:
        with tempfile.NamedTemporaryFile(mode='w',suffix='.json',encoding='utf8') as f:
            json.dump(jobs,f,ensure_ascii=False);f.flush()
            result=subprocess.run(['node',str(repo/'scripts/kbl_grayzone/render_report_maps.mjs'),f.name],capture_output=True,text=True,timeout=150)
        if result.returncode:raise RuntimeError('저장된 2D 지도 표시를 갱신하지 못했습니다: '+result.stderr[-800:])
    return paths


def publication_map(snapshot,size):
    """Draw the saved analysis data with separated labels, without moving entities.

    The grid is computed by the same JS and meshes as the review screen and its
    nine-ray results must match the saved results before it is shown.
    """
    import json,subprocess,tempfile
    from pathlib import Path
    from PIL import ImageFont
    script=Path(__file__).with_name('report_coverage.mjs')
    with tempfile.NamedTemporaryFile(mode='w',suffix='.json',encoding='utf8') as tmp:
        json.dump(snapshot,tmp,ensure_ascii=False);tmp.flush()
        done=subprocess.run(['node',str(script),tmp.name],capture_output=True,text=True,timeout=60)
    if done.returncode:raise ValueError('코트 시야 결과를 기존 저장값과 대조하지 못했습니다: '+done.stderr[-500:])
    data=json.loads(done.stdout);state=snapshot['state'];bodies=data['bodies'];target=data['target']
    # Draw at double resolution; all points retain their saved coordinates.
    scale_image=2;w,h=(int(size[0]*2),int(size[1]*2));ratio=w/h
    pts=[(e['x'],e['y']) for e in bodies]+[(target['x'],target['y'])]
    left=min(x for x,y in pts)-1.7;right=max(x for x,y in pts)+1.7
    top=min(y for x,y in pts)-1.7;bottom=max(y for x,y in pts)+1.7
    width=max(14,right-left);height=max(9,bottom-top)
    if width/height<ratio:width=height*ratio
    else:height=width/ratio
    cx=(left+right)/2;cy=(top+bottom)/2;left=cx-width/2;top=cy-height/2
    factor=w/width
    def pt(x,y):return ((x-left)*factor,(y-top)*factor)
    def rect(x1,y1,x2,y2):return (*pt(x1,y1),*pt(x2,y2))
    im=Image.new('RGB',(w,h),'#ba8254');d=ImageDraw.Draw(im)
    d.rectangle(rect(0,0,28,15),fill='#dba46e')
    floor=(219,164,110)
    palette=[None,(196,234,219),(119,197,167),(50,134,108)]
    complete=snapshot['crewAnalysis']['crewComplete'] and snapshot['crewAnalysis']['sceneComplete'] and not snapshot['crewAnalysis'].get('qualityWarnings')
    for cell in data['cells']:
        if cell['occupied']:continue
        raw=palette[min(3,cell['visible'])] if cell['visible'] else ((147,153,165) if complete else (233,233,239))
        color=tuple(round(.79*a+.21*b) for a,b in zip(raw,floor))
        d.rectangle(rect(cell['x'],cell['y'],cell['x']+cell['w'],cell['y']+cell['h']),fill=color)
    court='#fff5e2';thick=max(2,round(.05*factor))
    def line(points,fill=court,width=thick):d.line([pt(*p) for p in points],fill=fill,width=width,joint='curve')
    def circle(x,y,r,color=court,width=thick):d.ellipse(rect(x-r,y-r,x+r,y+r),outline=color,width=width)
    def arc(x,y,r,a,b,color=court,width=thick,segments=100,dash=False):
        points=[(x+math.cos(a+(b-a)*i/segments)*r,y+math.sin(a+(b-a)*i/segments)*r) for i in range(segments+1)]
        if dash:
            for i in range(0,segments,4):line(points[i:min(i+2,segments)+1],color,width)
        else:line(points,color,width)
    d.rectangle(rect(.025,.025,27.975,14.975),outline=court,width=thick)
    line([(14,0),(14,15)]);circle(14,7.5,1.8)
    angle=math.asin(6.6/6.75)
    for flip in (False,True):
        def coord(x,y):return (28-x,15-y) if flip else (x,y)
        line([coord(0,5.05),coord(5.8,5.05),coord(5.8,9.95),coord(0,9.95)])
        # Draw the same 6.75 m arc and corner lines as the saved court asset.
        cx2=26.425 if flip else 1.575
        if flip:
            arc(cx2,7.5,6.75,math.pi-angle,math.pi+angle)
            join=28-2.990097;line([(28,.9),(join,.9)]);line([(join,14.1),(28,14.1)])
        else:
            arc(cx2,7.5,6.75,-angle,angle)
            line([(0,.9),(2.990097,.9)]);line([(2.990097,14.1),(0,14.1)])
        free=22.2 if flip else 5.8
        arc(free,7.5,1.8,math.pi/2,3*math.pi/2,dash=not flip)
        arc(free,7.5,1.8,-math.pi/2,math.pi/2,dash=flip)
        circle(cx2,7.5,.225,'#ef7d25',max(2,round(.07*factor)))
        line([coord(1.2,6.6),coord(1.2,8.4)])
        if flip:
            arc(26.425,7.5,1.3,math.pi/2,3*math.pi/2)
        else:
            arc(1.575,7.5,1.3,-math.pi/2,math.pi/2)
        line([coord(1.2,6.2),coord(1.575,6.2)])
        line([coord(1.2,8.8),coord(1.575,8.8)])
        for x in (1.75,2.65,3.05,3.95,4.85):
            line([coord(x,5.05),coord(x,4.9)]);line([coord(x,9.95),coord(x,10.1)])
    # Same saved view angles, drawn behind bodies and labels.
    fov=data['config']['hfov']*math.pi/360
    for ref in data['observers']:
        for a in (ref['heading']-fov,ref['heading']+fov):
            line([(ref['x'],ref['y']),(ref['x']+40*math.cos(a),ref['y']+40*math.sin(a))],'#e76925',3)
    font_path=Path(__file__).resolve().parents[2]/'apps/web/public/kbl-grayzone/assets/report-fonts/KBLJump_B.otf'
    font=ImageFont.truetype(str(font_path),32)
    marks=[{'x':pt(e['x'],e['y'])[0],'y':pt(e['x'],e['y'])[1],'label':e['label'],'role':e['role'],'team':e.get('team')} for e in bodies]
    tx,ty=pt(target['x'],target['y']);marks.append({'x':tx,'y':ty,'label':'★','role':'target'})
    # Put short label pills outside every marker and previously placed pill.
    obstacles=[(m['x']-16,m['y']-16,m['x']+16,m['y']+16) for m in marks];placed=[]
    def collides(a,b):return a[0]<b[2] and a[2]>b[0] and a[1]<b[3] and a[3]>b[1]
    for m in marks:
        tw=math.ceil(d.textlength(m['label'],font=font))+14;th=36;found=None
        for radius in (20,38,58,82,110,145,190,250,340):
            for angle in (0,-math.pi/4,math.pi/4,-math.pi/2,math.pi/2,math.pi,3*math.pi/4,-3*math.pi/4):
                x=m['x']+radius*math.cos(angle);y=m['y']+radius*math.sin(angle)
                box=(round(x if math.cos(angle)>=0 else x-tw),round(y-th/2),round((x if math.cos(angle)>=0 else x-tw)+tw),round(y+th/2))
                if box[0]<2 or box[1]<2 or box[2]>w-2 or box[3]>h-2:continue
                if not any(collides(box,b) for b in obstacles+placed):found=box;break
            if found:break
        if not found:raise ValueError('KBL 코트 표식이 너무 밀집해 읽기 쉬운 범례를 배치할 수 없습니다.')
        m['box']=found;placed.append(found)
    for m in marks:
        if 'box' in m:
            x1,y1,x2,y2=m['box'];d.line((m['x'],m['y'],(x1+x2)/2,(y1+y2)/2),fill='#34405c',width=2)
    colors={'referee':'#ed873f','player':'#2797ba','staff':'#7c5e9b','unknown':'#969ba4'}
    # Concentric outlines preserve multiple markers at effectively the same
    # projection; their saved coordinates remain unchanged.
    occupied=[]
    for m in (m for m in marks if m['role']!='target'):
        near=sum(math.hypot(m['x']-o['x'],m['y']-o['y'])<14 for o in occupied)
        m['radius']=10+near*4;occupied.append(m)
    for m in sorted(occupied,key=lambda v:v['radius'],reverse=True):
        x,y=m['x'],m['y'];r=m['radius'];color=(snapshot.get('uniforms',{}).get(m.get('team')) if m['role']=='player' and m.get('team') in ('home','away') else None) or colors.get(m['role'],'#969ba4')
        d.ellipse((x-r,y-r,x+r,y+r),fill=color,outline='#17213a',width=2)
    # A leader connects the star label to the exact target point, so the icon
    # does not cover a player whose position coincides with the review point.
    d.ellipse((tx-4,ty-4,tx+4,ty+4),fill='#ffbf35',outline='#101633',width=2)
    for m in marks:
        if 'box' in m:
            box=m['box'];d.rounded_rectangle(box,radius=6,fill='#ffffff',outline='#697484',width=1)
            if m['role']=='target':star(d,(box[0]+box[2])/2,(box[1]+box[3])/2,13)
            else:d.text((box[0]+7,box[1]+1),m['label'],font=font,fill='#17213a')
    proof={'method':'saved-visibility-grid-with-separated-labels','size':list(size),'targetId':state['targetId'],'targetXY':[target['x'],target['y']],
        'markerPixels':[tx/2,ty/2],'positionSource':'manual-map' if state.get('reviewPoint') else 'saved-reconstruction-target',
        'labelCount':len(placed),'labelOverlaps':sum(collides(a,b) for i,a in enumerate(placed) for b in placed[i+1:]),'savedRayCountsVerified':True}
    return im.resize(size,Image.Resampling.LANCZOS),proof
