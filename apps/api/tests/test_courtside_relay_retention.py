import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
import uuid
from unittest.mock import Mock

from app.courtside_recording_source import recording_key
from app.courtside_relay_retention import MIN_AGE, clean_stale_partials, protected_matches


class RelayRetentionTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
  self.ids=[str(uuid.uuid4()) for _ in range(6)]
  self.rows=[{'fpcMatchId':mid,'date':'2026-11-01','gameNumber':str(i+1)} for i,mid in enumerate(self.ids)]
  self.now=time.time();self.s3=Mock();self.s3.head_object.return_value={'ContentLength':10,'ETag':'v1'}
 def fragment(self,mid,*,old=True,etag='v1'):
  sid=str(uuid.uuid4());key=recording_key(mid,sid,'take-00001-part-000001.mp4');iid='a'*24
  folder=self.root/'outputs/kbl-fpc-relay'/mid/iid/sid;folder.mkdir(parents=True)
  name='.incoming-'+hashlib.sha256(('bucket\0'+key).encode()).hexdigest()
  part=folder/(name+'.part');marker=folder/(name+'.json')
  part.write_bytes(b'abc');marker.write_text(json.dumps({'bucket':'bucket','key':key,'size':10,'etag':etag}))
  if old:
   stamp=self.now-MIN_AGE-1;os.utime(part,(stamp,stamp));os.utime(marker,(stamp,stamp))
  return part,marker
 def clean(self,current=None):
  return clean_stale_partials(self.root,self.s3,'bucket',current or self.ids[-1],self.rows,now=self.now)
 def test_only_old_unprotected_fragment_with_matching_s3_is_removed(self):
  old,marker=self.fragment(self.ids[0]);recent,_=self.fragment(self.ids[1],old=False)
  protected,_=self.fragment(self.ids[3]);final=old.parent/'result.mp4';final.write_bytes(b'final')
  result=self.clean()
  self.assertEqual(result,{'removed':1,'bytes':3});self.assertFalse(old.exists());self.assertFalse(marker.exists())
  self.assertTrue(recent.exists());self.assertTrue(protected.exists());self.assertEqual(final.read_bytes(),b'final')
 def test_changed_or_unavailable_source_is_preserved(self):
  part,_=self.fragment(self.ids[0]);self.s3.head_object.return_value={'ContentLength':10,'ETag':'v2'}
  self.assertEqual(self.clean()['removed'],0);self.assertTrue(part.exists())
 def test_fragment_modified_during_source_check_is_preserved(self):
  part,_=self.fragment(self.ids[0])
  def changing(**kwargs):
   part.write_bytes(b'new bytes')
   return {'ContentLength':10,'ETag':'v1'}
  self.s3.head_object.side_effect=changing
  self.assertEqual(self.clean()['removed'],0);self.assertEqual(part.read_bytes(),b'new bytes')
  self.s3.head_object.side_effect=OSError('unavailable')
  self.assertEqual(self.clean()['removed'],0);self.assertTrue(part.exists())
 def test_symlink_and_invalid_metadata_are_never_deleted(self):
  part,marker=self.fragment(self.ids[0]);target=self.root/'outside';target.write_bytes(b'outside');part.unlink();part.symlink_to(target)
  other,other_marker=self.fragment(self.ids[1]);data=json.loads(other_marker.read_text());data['key']='unrelated';other_marker.write_text(json.dumps(data));stamp=self.now-MIN_AGE-1;os.utime(other_marker,(stamp,stamp))
  self.assertEqual(self.clean()['removed'],0);self.assertTrue(part.is_symlink());self.assertTrue(other.exists());self.assertEqual(target.read_bytes(),b'outside');self.s3.head_object.assert_not_called()
 def test_ambiguous_or_unknown_current_match_disables_cleanup(self):
  part,_=self.fragment(self.ids[0]);self.rows[-1]['date']='unknown'
  self.assertIsNone(protected_matches(self.ids[-1],self.rows));self.assertEqual(self.clean()['removed'],0);self.assertTrue(part.exists())
 def test_reopened_old_game_and_its_predecessors_are_protected(self):
  self.assertEqual(protected_matches(self.ids[2],self.rows),set(self.ids))
  self.assertIsNone(protected_matches(str(uuid.uuid4()),self.rows))
 def test_symlinked_storage_ancestor_is_not_traversed(self):
  with tempfile.TemporaryDirectory() as outside:
   (self.root/'outputs').symlink_to(Path(outside),target_is_directory=True)
   self.assertEqual(self.clean()['removed'],0);self.s3.head_object.assert_not_called()

if __name__=='__main__':unittest.main()
