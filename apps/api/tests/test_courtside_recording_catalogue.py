import json
import tempfile
import unittest
import uuid
from pathlib import Path

from app.courtside_recording_catalogue import parts_for_match

class RecordingCatalogueTests(unittest.TestCase):
 def test_returns_only_match_scoped_valid_part_names_and_no_secrets(self):
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);mid=str(uuid.uuid4());sid=str(uuid.uuid4());other=str(uuid.uuid4())
   name='take-00001-part-000001.mp4';key=f'prelaunch/recordings/{mid}/{sid}/{name}'
   state={'id':sid,'match_id':mid,'created_at':'2026-11-14T01:00:00Z','status':'recording','stream_key':'PRIVATE-STREAM-KEY',
          'parts':[{'name':name,'key':key,'duration':10},{'name':'bad.mp4','key':'secret','duration':1},
                   {'name':name,'key':key,'duration':11}]}
   (root/sid).mkdir();(root/sid/'state.json').write_text(json.dumps(state))
   (root/other).mkdir();(root/other/'state.json').write_text(json.dumps({**state,'id':other,'match_id':str(uuid.uuid4())}))
   rows=parts_for_match(root,mid)
   self.assertEqual(len(rows),1);self.assertEqual(rows[0]['id'],sid)
   self.assertEqual([p['number'] for p in rows[0]['parts']],[1,3]);self.assertEqual(rows[0]['parts'][0]['sourcePartName'],name)
   serialized=json.dumps(rows);self.assertNotIn('PRIVATE-STREAM-KEY',serialized);self.assertNotIn(key,serialized);self.assertNotIn('secret',serialized)
 def test_symlinks_and_mismatched_session_ids_are_ignored(self):
  with tempfile.TemporaryDirectory() as folder,tempfile.TemporaryDirectory() as outside:
   root=Path(folder);mid=str(uuid.uuid4());sid=str(uuid.uuid4());other=str(uuid.uuid4())
   (root/sid).symlink_to(outside,target_is_directory=True)
   (root/other).mkdir();(root/other/'state.json').write_text(json.dumps({'id':sid,'match_id':mid,'parts':[]}))
   self.assertEqual(parts_for_match(root,mid),[])
   (root/other/'state.json').unlink();(root/other/'state.json').symlink_to(Path(outside)/'state.json')
   self.assertEqual(parts_for_match(root,mid),[])

if __name__=='__main__':unittest.main()
