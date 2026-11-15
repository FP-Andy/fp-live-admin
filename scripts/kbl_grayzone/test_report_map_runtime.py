"""Exercise the real report-map renderer without real match data or network."""
import copy
import os
from pathlib import Path
import tempfile
import unittest
from PIL import Image
from report_map import prepare_map_presentations


@unittest.skipUnless(os.environ.get('COURTSIDE_MAP_QA') == '1', 'map runtime QA is not enabled')
class ReportMapRuntimeTests(unittest.TestCase):
 def snapshot(self):
  return {'caseId':'synthetic','eventId':'review-1',
   'state':{'entities':[{'id':'p1','role':'player','team':'home','x':12,'y':7,'bodyHeading':0,'bodyDirectionSource':'manual'},
                        {'id':'r1','role':'referee','x':2,'y':7,'viewHeading':0}],
            'targetId':'p1','observerId':'r1','targetHeight':1.1,'hfov':100,'vfov':70},
   'crewAnalysis':{'rows':[{'id':'r1','heading':0,'counts':{'visible':9,'blocked':0,'outside':0}}],
                   'crewComplete':False,'sceneComplete':True}}

 def test_renders_and_rejects_mismatched_visibility(self):
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory);case={'home':'홈','away':'어웨이'};snapshot=self.snapshot()
   paths=prepare_map_presentations(root,case,{'review-1':snapshot})
   with Image.open(paths['review-1']) as image:
    self.assertEqual(image.size,(1280,800));self.assertGreater(len(image.getcolors(maxcolors=1000000)),10)
   self.assertEqual(paths,prepare_map_presentations(root,case,{'review-1':snapshot}))
   changed=copy.deepcopy(snapshot);changed['crewAnalysis']['rows'][0]['counts']['visible']=0
   with self.assertRaisesRegex(RuntimeError,'일치하지 않습니다'):
    prepare_map_presentations(root,case,{'review-1':changed})

if __name__=='__main__':unittest.main()
