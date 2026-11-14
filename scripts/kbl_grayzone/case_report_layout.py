"""Summary + one page per incident, with identical provenance gates to the UI."""
import hashlib
import json
from functools import lru_cache
from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen.canvas import Canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from report_assets import report_assets_dir
from case_evidence import extract_frame, sample_boxes
from case_store import broadcast_packet
from report_commentary import entity_labels, target_label
from report_map import marked_map, prepare_map_presentations
from report_editorial import load_editorial, summary, scene_commentary, official_label

NAVY='#101633'; ORANGE='#f34d0b'; GRAY='#667084'; LIGHT='#f4f6f9'; LINE='#e3e7ed'
W,H=1240,1754


def exact_pose(pose, row):
    return pose if pose and all(pose.get(k)==row.get(k) for k in ('frameIndex','datasetId','inputSha256','imageSha256')) else None


def wide_reference(root, event, snapshot):
    """Show the selected reference and explicitly annotated manual supplementation."""
    manifest=root/'wide-references.json'
    if not manifest.is_file():return None,None
    item=json.loads(manifest.read_text()).get('events',{}).get(event['id'])
    if not item:return None,None
    bound=(item.get('broadcastFrame')==snapshot['frameIndex']) if item.get('broadcastFrame') is not None else item.get('captureId')==snapshot['captureId']
    if not bound and item.get('captureId'):
        source_capture=root/'reconstructions'/event['id']/item['captureId']/'scene.json'
        if source_capture.is_file():bound=json.loads(source_capture.read_text()).get('frameIndex')==snapshot['frameIndex']
    if item.get('broadcastSha256')!=event.get('broadcast',{}).get('sha256') or not bound:
        return None,{'status':'stale-reference-omitted'}
    pair=(event.get('broadcastSelection') or {}).get('widePair') or {}
    if item.get('pairRevision') and (pair.get('revision')!=item['pairRevision'] or pair.get('scope')!='selected-instant'
        or pair.get('broadcastFrame')!=snapshot.get('frameIndex') or pair.get('broadcastSha256')!=event.get('broadcast',{}).get('sha256')
        or pair.get('sourceSha256')!=(item.get('source') or {}).get('sourceSha256') or pair.get('frameIndex')!=(item.get('source') or {}).get('frameIndex')):
        return None,{'status':'stale-reference-omitted'}
    path=(root/item['image']).resolve()
    if not path.is_relative_to(root.resolve()):raise ValueError('광각 참고 이미지 경로를 확인하세요.')
    if hashlib.sha256(path.read_bytes()).hexdigest()!=item['imageSha256']:raise ValueError('광각 참고 이미지가 변경됐습니다.')
    image=cv2.imread(str(path))
    if image is None:raise ValueError('광각 참고 이미지를 읽을 수 없습니다.')
    refs=(snapshot.get('sceneEvidence') or {}).get('supplementalReferees',[])
    for ref in refs:
        x1,y1,x2,y2=map(int,ref['pixelBox']);cv2.rectangle(image,(x1,y1),(x2,y2),(11,77,243),3)
        label=entity_labels(snapshot).get(ref['id'],'R*');cv2.putText(image,label,(x1,max(20,y1-5)),cv2.FONT_HERSHEY_SIMPLEX,.7,(11,77,243),2)
    # New manually selected references may have no display crop. Preserve the
    # complete verified image instead of inventing a crop or dropping evidence.
    crop=item.get('displayCrop')
    if crop is None:crop=[0,0,image.shape[1],image.shape[0]]
    if not isinstance(crop,(list,tuple)) or len(crop)!=4 or any(type(v) is not int for v in crop):
        raise ValueError('광각 참고 이미지 범위를 확인하세요.')
    x1,y1,x2,y2=crop
    if not (0<=x1<x2<=image.shape[1] and 0<=y1<y2<=image.shape[0]):raise ValueError('광각 참고 이미지 범위를 확인하세요.')
    # The selected image itself is unchanged. In the report show the entire
    # reference frame so it occupies the same-sized panel as the broadcast.
    saved_crop=list(crop)
    crop=[0,0,image.shape[1],image.shape[0]]
    x1,y1,x2,y2=crop
    manual=bool(item.get('pairRevision'))
    proof={**item,'sourceDisplayCrop':saved_crop,'displayCrop':list(crop),'status':'operator-selected-instant' if manual else 'clock-and-action-reference',
        'operatorConfirmedInstant':manual,'wideFrameIndex':pair.get('frameIndex') if manual else None,
        'wideSourceSha256':pair.get('sourceSha256') if manual else None,'frameAccurateSyncVerified':False,
        'usedInGeometry':bool(refs),'objectAnnotations':bool(refs),'poseAnnotations':False}
    return image[y1:y2,x1:x2],proof


def scene_images(case_id, root, event, row, snapshot, poses, inputs, evidence=None):
    """Never put old keypoints onto a newly chosen evidence frame."""
    from case_report import annotated
    from basketball_detector import deinterlace
    import broadcast_pose
    packet=broadcast_packet(case_id,event['id'])
    frame=next(f for f in packet['frames'] if f['frameIndex']==snapshot['frameIndex'])
    image=extract_frame(root/'broadcast'/event['broadcast']['file'],snapshot['frameIndex'])
    people=[dict(b,role=b['roleHint'],pixelBox=[v*s for v,s in zip(b['box'],[packet['width'],packet['height']]*2)]) for b in frame['boxes'] if b.get('imageSource','broadcast')=='broadcast']
    current=broadcast_pose.current(case_id,event['id'])
    bpose=current['job']['result'] if current and current['job']['state']=='complete' else None
    all_pose=bpose
    if bpose:bpose={**bpose,'people':[p for p in bpose['people'] if p.get('imageSource','broadcast')=='broadcast']}
    if evidence is not None:evidence.update(broadcastOriginal=image,broadcastObjects=people,broadcastPose=bpose,broadcastFrame=frame)
    primary=annotated(image,{'people':people,'ball':frame.get('ball')},bpose,entity_labels(snapshot))
    proof={'broadcast':{'frameIndex':snapshot['frameIndex'],'objectCount':len(people),'poseCount':len(bpose['people']) if bpose else 0,'datasetId':packet['datasetId'],'inputSha256':packet['inputSha256']}}
    secondary=None
    if packet.get('wideAssistance',{}).get('state')=='ready':
        import multiview
        data=json.loads((multiview.folder(root,event['id'],snapshot['frameIndex'])/'current.json').read_text())
        wide=cv2.imread(str(root/data['sourceImage']));ids={b['id'] for b in frame['boxes']}
        corrections={p['id']:p for p in (all_pose or {}).get('people',[]) if p.get('imageSource')=='wide'}
        subjects=[{**s['person'],'id':s['id'],'confidence':s['person'].get('roleConfidence',0)} for s in data['supplements'] if s['id'] in ids]
        wpose={'people':[corrections.get(p['id'],p) for p in subjects]}
        secondary=annotated(wide,{'people':subjects},wpose,entity_labels(snapshot))
        proof['wide']={'frameIndex':data['wideSource']['frameIndex'],'inputSha256':data['wideSource']['sourceSha256'],
            'objectCount':len(subjects),'poseCount':len(wpose['people']),'identityMatchedToBroadcast':True,
            'frameAccurateSyncVerified':False,'usedInGeometry':True,'method':data['temporalMethod']}
        if evidence is not None:evidence.update(wideOriginal=wide,wideObjects=subjects,widePose=wpose)
    if event.get('wide'):
        extra=(snapshot.get('sceneEvidence') or {});wf=extra.get('wide',{}).get('frameIndex',row['frameIndex'])
        if wf==row['frameIndex']:
            wide=cv2.imread(str(inputs/row['image']));wide_row=row
            wpose=exact_pose(poses.get(row['clipId']),row)
        else:
            wide=deinterlace(extract_frame(Path(event['wide']['file']),wf))
            tracks=json.loads((root/'results/tracks'/event['wide']['id']/'people.json').read_text())
            boxes=sample_boxes(tracks['frames'],wf/event['wide']['fps'])
            wide_row={'people':[dict(b,id='T'+str(b['id']),role=b['roleHint'],pixelBox=[v*s for v,s in zip(b['box'],[wide.shape[1],wide.shape[0]]*2)]) for b in boxes]}
            wpose=None
        labels={p['id']:'W'+str(i+1) for i,p in enumerate(wide_row['people'])}
        secondary=annotated(wide,wide_row,wpose,labels)
        for ref in extra.get('supplementalReferees',[]):
            x1,y1,x2,y2=map(int,ref['pixelBox']);cv2.rectangle(secondary,(x1,y1),(x2,y2),(11,77,243),3)
            cv2.putText(secondary,'R3*',(x1,y1-7),cv2.FONT_HERSHEY_SIMPLEX,.65,(11,77,243),2)
        # Crop only empty stands; retain every box and the scorer-table referee.
        ys=[p['pixelBox'][i] for p in wide_row['people'] for i in (1,3)]
        ys += [r['pixelBox'][i] for r in extra.get('supplementalReferees',[]) for i in (1,3)]
        top=max(0,min(350,int(min(ys))-25)) if ys else 0
        bottom=min(wide.shape[0],max(900,int(max(ys))+25)) if ys else wide.shape[0]
        secondary=secondary[top:bottom]
        if evidence is not None:evidence.update(wideOriginal=wide,wideObjects=wide_row['people'],widePose=wpose,wideBall=wide_row.get('ball'))
        proof['wide']={'frameIndex':wf,'objectCount':len(wide_row['people']),'poseCount':len(wpose['people']) if wpose else 0,
            'poseStatus':'exact-frame' if wpose else 'not-available-for-selected-frame','displayCrop':[0,top,wide.shape[1],bottom],
            'inputSha256':event['wide']['sha256'],'identityMatchedToBroadcast':False,
            'boxSources':sorted(set(p.get('boxSource','unknown') for p in wide_row['people']))}
    return primary,secondary,proof


def create_packet(case_id,case,root,rows,spatial,notes,poses,inputs,output,progress=None):
    from wide_reference import version as wide_version
    wide_reference_sha=wide_version(root)
    editorial_path=root/'report-editorial.json'
    editorial_sha=hashlib.sha256(editorial_path.read_bytes()).hexdigest() if editorial_path.exists() else None
    editorial=load_editorial(root,case,spatial);stats=summary(case)
    comments={e['id']:scene_commentary(case,e,spatial[e['id']],editorial.get('events',{}).get(e['id'],{})) for e in case['events']}
    map_paths=prepare_map_presentations(root,case,spatial) if all(s.get('caseId') for s in spatial.values()) else {}
    lookup={r['eventId']:r for r in rows};pages=[];commands=[];current_commands={'text':[],'images':[]};page_count=1+len(case['events']);page_map=[];proofs={}
    fonts=root/'report-fonts'
    if not fonts.exists():fonts=report_assets_dir()
    pages_dir=root/'report-pages'/'summary-clips-v12';pages_dir.mkdir(parents=True,exist_ok=True)
    @lru_cache(None)
    # Measure with the same TrueType faces embedded in the PDF so wrapping
    # and visual output use the same glyph advances.
    def font(size,bold=False):return ImageFont.truetype(str(fonts/('KBLJump_B.ttf' if bold else 'KBLJump_R.ttf')),size)
    logo=Image.open(fonts/'kbl-logo.png').convert('RGBA');logo.thumbnail((86,48))
    def wording(value):
        for old,new in [('중계뷰','중계 화면'),('광각뷰','광각 화면'),('심판뷰','심판 화면'),('3D 뷰','3D 화면')]:value=str(value).replace(old,new)
        return value
    def text(d,x,y,value,size=24,bold=False,color=NAVY):
        current_commands['text'].append({'x':x,'y':y,'value':wording(value),'size':size,'bold':bold,'color':color,'ascent':font(size,bold).getmetrics()[0]})
    def lines(d,value,width,size,bold=False):
        result=[];line=''
        for ch in wording(value)+'\n':
            if ch=='\n' or (line and d.textlength(line+ch,font=font(size,bold))>width):
                result.append(line);line='' if ch=='\n' else ch
            else:line+=ch
        # Keep a sentence ending from becoming a one-character final line.
        if len(result)>1 and 0<len(result[-1].strip())<5 and ' ' in result[-2]:
            head,tail=result[-2].rsplit(' ',1)
            if d.textlength(tail+result[-1],font=font(size,bold))<=width:result[-2]=head;result[-1]=tail+result[-1]
        return result
    def paragraph(d,x,y,value,width,size=23,leading=32,color=NAVY,bottom=None,bold=False):
        content=lines(d,value,width,size,bold)
        if bottom and y+len(content)*leading>bottom:raise ValueError(f'리포트 문단이 영역을 넘습니다: {value[:45]}')
        for line in content:text(d,x,y,line,size,bold=bold,color=color);y+=leading
        return y
    def summary_cell(d,x,y,value,width,bottom,size=20):
        # Ten-scene summaries have 60px rows. Fit complete text within the
        # cell, allowing two lines without sacrificing or truncating facts.
        for candidate in range(size,15,-1):
            leading=candidate+4
            if y+len(lines(d,value,width,candidate))*leading<=bottom:
                return paragraph(d,x,y,value,width,candidate,leading,bottom=bottom)
        raise ValueError(f'판독 기록 요약 칸이 너무 깁니다. 문구를 간결하게 정리하세요: {value[:45]}')
    def fitted(im,image,x,y,width,height):
        if isinstance(image,np.ndarray):image=Image.fromarray(cv2.cvtColor(image,cv2.COLOR_BGR2RGB))
        image=image.convert('RGB');scale=min(width/image.width,height/image.height)
        iw,ih=round(image.width*scale),round(image.height*scale)
        target=pages_dir/f'asset-{len(pages)+1:02d}-{len(current_commands["images"])+1:02d}.jpg'
        image.save(target,quality=95,subsampling=0)
        current_commands['images'].append({'path':target,'x':x+(width-iw)//2,'y':y+(height-ih)//2,'width':iw,'height':ih})
        ImageDraw.Draw(im).rectangle((x,y,x+width,y+height),fill='white')
    def section(d,y,number,title):
        text(d,70,y,number,23,True,ORANGE);text(d,117,y,title,25,True)
        d.line((70,y+37,1170,y+37),fill=LINE,width=2)
    def page(compact=False):
        current_commands['text']=[];current_commands['images']=[]
        im=Image.new('RGB',(W,H),'white');d=ImageDraw.Draw(im);d.rectangle((0,0,W,12),fill=ORANGE)
        text(d,70,26 if compact else 57,'FINEPLAY / COURTSIDE',20 if compact else 24,True);im.paste(logo,(W-70-logo.width,20 if compact else 43),logo)
        header_y=75 if compact else 132
        d.line((70,header_y,1170,header_y),fill=LINE,width=2)
        text(d,70,1685,'KBL 판독 리포트 · '+case['date'],18,color=GRAY)
        text(d,1065,1685,f'{len(pages)+1:02d} / {page_count:02d}',22,True)
        return im,d
    def add(im):
        if progress:progress('리포트 페이지 구성',len(pages)+1,page_count,'페이지')
        p=pages_dir/f'page-{len(pages)+1:02d}.jpg';im.save(p,quality=95,subsampling=0);pages.append(p);commands.append({'text':current_commands['text'].copy(),'images':current_commands['images'].copy()})
    def duration(seconds):return f'{int(seconds)//60}:{int(seconds)%60:02d}'
    def team_short(value):return value.replace(' 나이츠','').replace(' 세이커스','').replace(' 소닉붐','').replace(' 스카이거너스','')
    def request_label(event):return team_short(event.get('requestingTeam','')) or event.get('requestType') or '심판 자체'

    # The first page is a factual game-level digest, not an additional cover.
    im,d=page();text(d,70,170,'경기 판독 리포트',42,True)
    title_lines=lines(d,case['title'],1100,41,True)
    if len(title_lines)>2:raise ValueError('경기 제목이 요약 페이지의 두 줄을 초과합니다. 제목을 간결하게 입력해 주세요.')
    paragraph(d,70,225,case['title'],1100,41,43,bold=True,bottom=311)
    text(d,70,318 if len(title_lines)>1 else 306,f"{case['date']}  ·  경기 {case['gameNumber']}",24,color=GRAY)
    text(d,70,359 if len(title_lines)>1 else 350,'배정 심판  '+(' / '.join(f"#{r['number']} {r['name']}" for r in case['referees']) or '미제공'),23)
    confirmed_moments=sum(e.get('broadcastSelection',{}).get('analysisMoment',{}).get('phase') in ('before','contact','after','context') for e in case['events'])
    complete_crews=sum(len(spatial[e['id']]['crewAnalysis']['rows'])==3 for e in case['events'])
    text(d,70,386,f"기준 순간 확인 {confirmed_moments}/{len(case['events'])}  ·  3심 위치 확보 {complete_crews}/{len(case['events'])}",18,color=GRAY)
    cards=[('판독 장면',f"{stats['count']}건"),('기록 분류',f"번복 {stats['decisions'].get('번복',0)} · 유지 {stats['decisions'].get('유지',0)} · 보류 {stats['decisions'].get('보류',0)}"),('총 소요 시간',duration(stats['totalSeconds'])),('평균 / 최장',f"{duration(round(stats['meanSeconds']))} / {duration(stats['maxSeconds'])}")]
    for i,(label,value) in enumerate(cards):
        x=70+i*280;d.rounded_rectangle((x,406,x+260,526),radius=10,fill=LIGHT)
        text(d,x+18,424,label,22,color=GRAY);text(d,x+18,465,value,23 if i==1 else 29,True,ORANGE if i==1 else NAVY)
    section(d,566,'01','판독 기록 요약')
    d.rectangle((70,618,1170,662),fill=NAVY)
    for x,t in [(85,'장면 / 시각'),(302,'요청'),(535,'소요 시간'),(650,'최초 콜'),(865,'기록 분류'),(1085,'쪽')]:text(d,x,627,t,20,True,'white')
    if len(case['events'])>10:raise ValueError('경기 요약 한 페이지는 최대 10개 판독 장면을 지원합니다.')
    row_h=68 if len(case['events'])<=9 else 60
    # The operational limit is ten incidents; the summary remains one page.
    for i,e in enumerate(case['events']):
        y=662+i*row_h;c=comments[e['id']]
        if i%2==0:d.rectangle((70,y,1170,y+row_h),fill=LIGHT)
        text(d,85,y+13,f"{e['number']:02d}  {e['quarter']}Q {e['gameClock']}",21,True)
        summary_cell(d,302,y+8,request_label(e),213,y+row_h,size=21)
        text(d,535,y+13,duration(e['reviewDurationSeconds']),20,color=GRAY)
        summary_cell(d,650,y+8,c['initialCall'],195,y+row_h)
        decision=e['recordedDecision'];bg,fg={'번복':('#ffe7dc','#a53100'),'유지':('#e3eafb','#1d346e'),'보류':('#e8eaef','#455064')}.get(decision,('#e8eaef','#455064'))
        d.rounded_rectangle((864,y+10,924,y+38),radius=8,fill=bg)
        text(d,874,y+12,decision,18,True,fg)
        summary_cell(d,932,y+8,e['recordedReason'],145,y+row_h)
        text(d,1092,y+16,str(i+2),23,True)
    y=662+len(case['events'])*row_h+34
    section(d,y,'02','경기 전체 검토 관점');y+=58
    overall=editorial.get('gameAssessment') or (f"총 {stats['count']}건의 판독 장면을 살펴봤습니다. 최초 콜과 최종 기록을 대조하고, 접촉을 읽기 좋은 각도와 선수의 가림이 판단에 미치는 영향을 중심으로 의견을 정리했습니다.")
    y=paragraph(d,70,y,overall,1100,22,30)+16
    scope='분석 기준: 자세와 공간은 중계 화면으로 구성했으며, 별표·대상 높이·시야각은 설정값입니다.'
    if any(e.get('wide') for e in case['events']):scope+=' 광각 화면은 장면 대조에 사용했습니다.'
    if (root/'wide-references.json').is_file():scope+=' 광각 참고 화면은 선택한 정지 프레임이며 같은 순간 여부는 선택 근거를 확인해야 합니다.'
    supplemented=[str(e['number']) for e in case['events'] if (spatial[e['id']].get('sceneEvidence') or {}).get('supplementalReferees')]
    if supplemented:scope+=(' 모든 장면의 누락 심판은 광각에서 근사 위치를 보완했습니다.' if len(supplemented)==len(case['events']) else ' '+', '.join(supplemented)+'번 장면의 추가 심판은 광각 화면을 참고한 근사 배치입니다.')
    scope+=' R번호는 장면별 라벨이며 배번·콜 담당자와 별도로 매칭합니다.'
    y=paragraph(d,70,y,scope,1100,19,26,bottom=1578)
    text(d,70,1630,'시야는 설정한 방향·시야각에 따른 재구성이며, 실제 주시 방향과 다를 수 있습니다.',19,color=ORANGE)
    add(im)

    for e in case['events']:
        snapshot=spatial[e['id']];state=snapshot['state'];a=snapshot['crewAnalysis'];row=lookup[e['id']];c=comments[e['id']]
        extra=(snapshot.get('sceneEvidence') or {});folder=root/'reconstructions'/e['id']/snapshot['captureId']
        primary,secondary,proof=scene_images(case_id,root,e,row,snapshot,poses,inputs);proofs[e['id']]=proof
        reference=False
        if secondary is None:
            secondary,reference_proof=wide_reference(root,e,snapshot)
            if reference_proof:proof['wideReference']=reference_proof
            reference=secondary is not None
        # Compact header provides space for equal-sized broadcast and wide views.
        im,d=page(compact=True);text(d,70,94,f"CLIP {e['number']:02d}",36,True,ORANGE)
        text(d,283,97,f"{e['quarter']}Q {e['gameClock']}  /  {e['recordedDecision']}",36,True)
        request=request_label(e)+(' 요청' if e.get('requestingTeam') else '')
        meta=f"{case['title']}  ·  {case['date']}  ·  {request}  ·  판독 {duration(e['reviewDurationSeconds'])}"
        y=paragraph(d,70,151,meta,1100,21,28,color=GRAY)
        y=paragraph(d,70,y+4,c['context'],1100,22,30)+10
        moment=e.get('broadcastSelection',{}).get('analysisMoment',{});phase={'before':'접촉 전','contact':'접촉 순간','after':'접촉 직후','context':'배치 참고'}.get(moment.get('phase'))
        clock_note=' · 화면 시계 '+moment['clock'] if moment.get('clock') and moment['clock']!=e['gameClock'] else ''
        section(d,y,'01','판독 장면'+(' · '+phase if phase else '')+clock_note)
        label_y=y+47;image_y=label_y+32
        text(d,70,label_y,'중계 화면',23,True)
        blocks=[('판독 지점',c['targetExplanation']),('시야 해설',c['viewComment']),('판독 쟁점',c['difficultyFactors'])]
        if c['callingReferee']!='최초 콜 심판 미기재':blocks.append(('실제 콜과 대조',c['comparison']))
        body_size=21;leading=29
        analysis_height=sum(29+len(lines(d,value,535,body_size))*leading+10 for _,value in blocks)
        # In a dense case retain readable text and calculate the required panel height.
        analysis_height=max(315,analysis_height)
        assessment_lines=lines(d,c['assessment'],1100,23,True)
        assessment_height=len(assessment_lines)*31
        # Keep visual panels at fixed readable sizes and report overflow explicitly.
        photo_h=300;eye_h=200
        projected=image_y+photo_h+25+47+analysis_height+26+47+30+eye_h+25+47+assessment_height+(30 if len(a['rows'])<3 else 0)
        if projected>1660:raise ValueError(f"클립 {e['number']}의 설명이 한 페이지의 읽기 쉬운 영역을 초과합니다. 중복 없이 문장을 간결하게 정리해 주세요.")
        # Both views have equal image boxes; contain rather than crop or stretch.
        fitted(im,primary,70,image_y,542,photo_h)
        side_x=628;side_w=542
        text(d,side_x,label_y,('광각 참고 화면' if reference else '광각 화면') if secondary is not None else '광각 화면 미연결',23,True)
        if secondary is not None:
            fitted(im,secondary,side_x,image_y,side_w,photo_h)
        y=image_y+photo_h+20;section(d,y,'02','판독 지점과 시야 분석');map_y=y+49
        map_height=300
        source=Image.open(map_paths.get(e['id'],folder/'crewMap.jpg')).convert('RGB')
        if source.size!=(1280,800):raise ValueError('2D 코트 이미지 형식이 변경되어 표시 범위를 확인해야 합니다.')
        # Saved Step 3 maps use the bottom strip for a legend; keep all court
        # pixels and markers while omitting only that strip from the report.
        entities=state.get('entities',[])
        map_x,map_origin_y,map_scale=((1280-28*28.5)/2,103,28.5) if e['id'] in map_paths or snapshot.get('mapLayout')=='apron-v2' else ((1280-28*33.5)/2,90,33.5)
        x_pixels=[map_x+float(p['x'])*map_scale for p in entities if isinstance(p.get('x'),(int,float))]
        x0=max(0,min(104,int(min(x_pixels)-45))) if x_pixels else 104
        x1=min(1280,max(1176,int(max(x_pixels)+45))) if x_pixels else 1176
        crop=source.crop((x0,0,x1,665));factor=min(530/crop.width,map_height/crop.height)
        cw,ch=round(crop.width*factor),round(crop.height*factor)
        m=Image.new('RGB',(530,map_height),'white');left=(530-cw)//2;top=(map_height-ch)//2
        m.paste(crop.resize((cw,ch),Image.Resampling.LANCZOS),(left,top))
        target=state.get('reviewPoint') or next((p for p in entities if p.get('id')==state.get('targetId')),None)
        map_proof={'method':'court-only-saved-map','crop':[x0,0,x1,665],'sourceSize':[1280,800],
            'size':[530,map_height],'displayBounds':[left,top,left+cw,top+ch],
            'targetId':state.get('targetId'),'targetXY':[target['x'],target['y']] if target else None,
            'markerPixels':[(map_x+target['x']*map_scale-x0)*factor+left,(map_origin_y+target['y']*map_scale)*factor+top] if target else None,
            'positionSource':'manual-map' if state.get('reviewPoint') else 'saved-reconstruction-target','overlayAdded':False}
        im.paste(m,(70,map_y));proof['map']=map_proof
        block_y=map_y
        for i,(label,value) in enumerate(blocks):
            text(d,625,block_y,('★ ' if i==0 else '')+label,22,True,ORANGE if i==0 else NAVY)
            block_y=paragraph(d,625,block_y+29,value,535,body_size,leading)+10
        y=max(map_y+analysis_height,block_y,map_y+map_height)+12
        section(d,y,'03','세 심판의 시점');eye_label_y=y+47;eye_y=eye_label_y+31
        refs=a['rows'][:3]
        # Missing positions take one short line; saved viewpoints divide the usable width.
        if refs:
            missing=3-len(refs)
            width=(1100-(len(refs)-1)*16)//len(refs)
            for i,ref in enumerate(refs):
                x=70+i*(width+16)
                text(d,x,eye_label_y,official_label(case,snapshot,ref,c['refereeAssignments']),21,True)
                eye=Image.open(folder/f'eye{i+1}.jpg').convert('RGB');pixels=np.asarray(eye).astype(np.int16)
                occupied=np.where(((np.ptp(pixels,axis=2)>28)|(pixels.min(axis=2)<130)).sum(axis=1)>3)[0]
                top=max(0,int(occupied[0])-20) if len(occupied) else 0
                snapshot.setdefault('reportDisplayCrop',{})[f'eye{i+1}']=[0,top,eye.width,eye.height]
                fitted(im,eye.crop((0,top,eye.width,eye.height)),x,eye_y,width,eye_h)
            y=eye_y+eye_h+5
        else:
            missing=3;y=eye_label_y
        if missing:
            text(d,70,y,'  ·  '.join(f'R{i+1} 위치 미확인' for i in range(len(refs),3)),19,color=GRAY);y+=26
        y+=16;section(d,y,'04','판독 총평');y+=48
        # Preserve the authored assessment verbatim; only emphasize its opening line.
        for i,line in enumerate(assessment_lines):
            text(d,70,y,line,23,bold=(i==0));y+=31
        if y>1667:raise ValueError(f"클립 {e['number']}의 총평이 한 페이지 영역을 초과합니다.")
        page_map.append({'eventId':e['id'],'page':len(pages)+1,'evidencePage':len(pages)+1,'spatialPage':len(pages)+1})
        add(im)

    output.parent.mkdir(parents=True,exist_ok=True);pdf=Canvas(str(output),pagesize=A4,pageCompression=1)
    pdf.setTitle(f"KBL 경기{case['gameNumber']} {case['title']} - 경기 판독 리포트")
    pdf.setAuthor('Fineplay');pdf.setSubject('경기 요약 1페이지 + 장면별 1페이지. 기록 사실과 조건부 시야 재구성의 대조.')
    for name,file in [('KBLReportR','KBLJump_R.ttf'),('KBLReportB','KBLJump_B.ttf')]:
        if name not in pdfmetrics.getRegisteredFontNames():pdfmetrics.registerFont(TTFont(name,str(report_assets_dir()/file)))
    scale=A4[0]/W
    for i,p in enumerate(pages):
        if progress:progress('PDF 페이지 저장',i,len(pages),'페이지')
        pdf.drawImage(ImageReader(str(p)),0,0,width=A4[0],height=A4[1])
        for asset in commands[i]['images']:
            pdf.drawImage(ImageReader(str(asset['path'])),asset['x']*scale,(H-asset['y']-asset['height'])*scale,width=asset['width']*scale,height=asset['height']*scale)
        for item in commands[i]['text']:
            pdf.setFillColor(item['color']);pdf.setFont('KBLReportB' if item['bold'] else 'KBLReportR',item['size']*scale)
            pdf.drawString(item['x']*scale,(H-item['y']-item['ascent'])*scale,item['value'])
        pdf.showPage()
    pdf.save()
    metadata={'schema':'kbl-case-review-packet/v2','status':'tracking-review-draft','caseId':case_id,'pageCount':len(pages),
        'layoutVersion':'summary-clips-v12','summaryPage':1,'pagePairs':page_map,'summary':stats,
        'csvSha256':case['csvSha256'],'totalProcessingSeconds':sum(r['runtime']['totalSeconds'] for r in rows),
        'metricCalibrationVerified':False,'gazeVerified':False,'identityVerified':False,
        'poseIncluded':any(p['broadcast']['poseCount'] for p in proofs.values()),'frameAnnotations':proofs,
        'frames':rows,'notes':notes,'analysisComments':comments,'editorialSource':editorial.get('source',{}),
        'editorialSha256':editorial_sha,'wideReferenceSha256':wide_reference_sha,
        'broadcastReconstructions':spatial,'pdfSha256':hashlib.sha256(output.read_bytes()).hexdigest()}
    output.with_suffix('.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'pdf':str(output),'pages':len(pages),'status':metadata['status']},ensure_ascii=False))
    return metadata
