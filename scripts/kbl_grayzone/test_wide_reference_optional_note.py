import hashlib,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import cv2,numpy as np
import wide_reference,scene_evidence

class WideReferenceNoteTests(unittest.TestCase):
 def test_supplement_saves_without_prose_and_retains_existing_note(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp); image=root/'wide.jpg'; cv2.imwrite(str(image),np.zeros((100,150,3),dtype=np.uint8))
   sha=hashlib.sha256(image.read_bytes()).hexdigest()
   item={'image':'wide.jpg','imageSha256':sha,'broadcastFrame':7}
   (root/'wide-references.json').write_text(json.dumps({'events':{'review-1':item}}))
   case={'referees':[{'number':8},{'number':13}]};event={'id':'review-1','broadcast':{'sha256':'source'}}
   packet={'inputSha256':'source','datasetId':'dataset'};frame={'frameIndex':7,'floorPositions':[]}
   current={'version':'v','broadcastRefereeCount':0}
   people=[{'id':'wide-ref-review-1-a','pixelBox':[2,3,20,40],'xy':[1,2],'number':8},
           {'id':'wide-ref-review-1-b','pixelBox':[30,3,50,40],'xy':[3,4],'number':13,'note':'기존에 기록한 근거'}]
   with patch.dict(wide_reference.case_store.CASES,{'game-test':root}),patch.object(wide_reference,'view',return_value=current),patch.object(wide_reference,'context',return_value=(case,event,packet,frame)),patch.object(wide_reference,'selected',return_value=item):
    wide_reference.save('game-test','review-1',{'version':'v','operation':'supplement','referees':people})
   saved=json.loads((root/'scene-evidence.json').read_text())['events']['review-1']['supplementalReferees']
   self.assertEqual(saved[0]['note'],'광각 화면에서 심판 박스와 2D 코트 위치를 지정했습니다.')
   self.assertEqual(saved[1]['note'],'기존에 기록한 근거')
   result=scene_evidence.load(root,event,packet,frame,case['referees'])
   self.assertEqual(len(result['supplementalReferees']),2)

if __name__=='__main__':unittest.main()
