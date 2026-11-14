"""Frozen ImageNet ResNet18 + learned 3-way role head. Game-disjoint evaluation.

This classifies detector crops; it cannot repair missed boxes or ball detections.
No augmentation. Best head selected on validation loss, test evaluated once.
"""
import argparse,copy,hashlib,json,time
from pathlib import Path
from collections import Counter
import cv2,numpy as np
from PIL import Image,ImageOps
import torch
from torch import nn
from torchvision.models import resnet18,ResNet18_Weights

LABELS=['player','referee','staff']
THRESHOLD=.8
def tensor(im):
    im=ImageOps.pad(im.convert('RGB'),(640,640),method=Image.Resampling.BILINEAR,color=(114,114,114))
    a=torch.from_numpy(np.array(im)).permute(2,0,1).float()/255
    return (a-torch.tensor([.485,.456,.406])[:,None,None])/torch.tensor([.229,.224,.225])[:,None,None]

def metrics(truth,pred):
    matrix=np.zeros((3,3),int)
    for a,b in zip(truth,pred):matrix[a,b]+=1
    f=[]
    for k in range(3):
        tp=int(matrix[k,k]);f.append(2*tp/max(1,int(matrix[k].sum()+matrix[:,k].sum())))
    return {'labels':LABELS,'confusionMatrix':matrix.tolist(),'accuracy':float(np.trace(matrix)/max(1,matrix.sum())),
            'macroF1':float(np.mean(f)),'perClassF1':dict(zip(LABELS,f)),'count':len(truth)}

def main(root):
    torch.manual_seed(251025);torch.set_num_threads(3)
    if not torch.cuda.is_available():raise RuntimeError('CUDA required for this benchmark')
    torch.backends.cudnn.benchmark=False
    start=time.perf_counter();manifest=json.loads((root/'manifest.json').read_text())
    rows=[r for r in manifest['images'] if r['label']]
    games={s:{r['gameId'] for r in rows if r['split']==s} for s in ['train','valid','test']}
    assert not games['train']&games['valid'] and not games['train']&games['test'] and not games['valid']&games['test']
    backbone=resnet18(weights=ResNet18_Weights.IMAGENET1K_V1);backbone.fc=nn.Identity();backbone.eval().cuda()
    for p in backbone.parameters():p.requires_grad_(False)
    features=[]
    with torch.inference_mode():
        for offset in range(0,len(rows),16):
            batch=torch.stack([tensor(Image.open(root/'crops'/f"{r['id']:04d}.jpg")) for r in rows[offset:offset+16]]).cuda()
            features.append(backbone(batch).cpu())
    features=torch.cat(features).cuda();targets=torch.tensor([LABELS.index(r['label']) for r in rows],device='cuda')
    masks={s:torch.tensor([r['split']==s for r in rows],device='cuda') for s in games}
    head=nn.Linear(512,3).cuda();optimizer=torch.optim.AdamW(head.parameters(),lr=.003,weight_decay=.03)
    counts=torch.bincount(targets[masks['train']],minlength=3);weight=counts.sum()/(3*counts.float())
    criterion=nn.CrossEntropyLoss(weight=weight);best=float('inf');best_state=None;history=[];best_epoch=0
    for epoch in range(400):
        head.train();optimizer.zero_grad();loss=criterion(head(features[masks['train']]),targets[masks['train']]);loss.backward();optimizer.step()
        head.eval()
        with torch.no_grad():valid=nn.functional.cross_entropy(head(features[masks['valid']]),targets[masks['valid']]).item()
        if valid<best:best=valid;best_state=copy.deepcopy(head.state_dict());best_epoch=epoch+1
        if epoch%25==0:history.append({'epoch':epoch+1,'trainLoss':loss.item(),'validLoss':valid})
    head.load_state_dict(best_state);head.eval();model=nn.Sequential(backbone,head).eval()
    with torch.inference_mode():probabilities=torch.softmax(head(features),1).cpu().numpy()
    reports={}
    for split in ['valid','test']:
        ids=[i for i,r in enumerate(rows) if r['split']==split];truth=[LABELS.index(rows[i]['label']) for i in ids]
        predicted=[int(probabilities[i].argmax()) for i in ids];baseline=[LABELS.index(rows[i]['proposalRole']) for i in ids]
        keep=[i for i in ids if probabilities[i].max()>=THRESHOLD]
        reports[split]={'model':metrics(truth,predicted),'publicDetectorRole':metrics(truth,baseline),
                        'accepted':metrics([LABELS.index(rows[i]['label']) for i in keep],[int(probabilities[i].argmax()) for i in keep]),
                        'coverage':len(keep)/len(ids)}
    model.cpu();script=torch.jit.trace(model,torch.zeros(1,3,640,640));script.save(str(root/'role-resnet18.pt'))
    digest=hashlib.sha256((root/'role-resnet18.pt').read_bytes()).hexdigest()
    result={'schema':'kbl-role-training/v1','status':'complete','model':'resnet18-imagenet-frozen-backbone-linear-role-head',
        'modelSha256':digest,'inputSize':640,'resize':'letterbox; RGB ImageNet normalization','augmentation':'none',
        'labels':LABELS,'threshold':THRESHOLD,'seed':251025,'selectedEpoch':best_epoch,'maxEpochs':400,'history':history,
        'trainingExamples':manifest['counts'],'gameSplits':{k:sorted(v) for k,v in games.items()},'evaluation':reports,
        'trainingWallSeconds':time.perf_counter()-start,'device':torch.cuda.get_device_name(),
        'limitations':['Crop role accuracy only, not detection mAP/IDF1 or full-frame recall','Single assistant visual labelling pass, expert review pending','No new ball training','Small purposive sample'],
        'predictions':[{'id':r['id'],'split':r['split'],'truth':r['label'],'proposalRole':r['proposalRole'],'probabilities':p.tolist()} for r,p in zip(rows,probabilities)]}
    (root/'training.json').write_text(json.dumps(result,indent=2))
    print(json.dumps({k:result[k] for k in ['status','selectedEpoch','trainingWallSeconds','evaluation']}),flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('root',type=Path);args=parser.parse_args();main(args.root)
