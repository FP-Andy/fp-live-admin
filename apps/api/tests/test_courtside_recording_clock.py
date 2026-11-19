import json
import shutil
import subprocess
import threading
from datetime import datetime, timezone
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from app.recording_engine import Recorder, observe_segment_starts, received_segment_time, capture_command, watch_segment_starts
from app.courtside_recording_catalogue import parts_for_match

class Store:
 def upload(self,path,key):return path.stat().st_size

class RecordingClockTests(unittest.TestCase):
 def test_observe_preserves_first_nonempty_segment_time_and_does_not_infer(self):
  with tempfile.TemporaryDirectory() as tmp:
   folder=Path(tmp);one=folder/'part-000000.mp4';two=folder/'part-000001.mp4';seen={}
   one.touch();self.assertFalse(observe_segment_starts(folder,seen,'2026-11-17T09:00:00+00:00'))
   self.assertIsNone(received_segment_time(one))
   one.write_bytes(b'frame');self.assertTrue(observe_segment_starts(folder,seen,'2026-11-17T09:00:01+00:00'))
   two.write_bytes(b'frame');self.assertTrue(observe_segment_starts(folder,seen,'2026-11-17T09:00:31+00:00'))
   self.assertEqual(received_segment_time(one),'2026-11-17T09:00:01+00:00')
   self.assertEqual(received_segment_time(two),'2026-11-17T09:00:31+00:00')
   self.assertFalse(observe_segment_starts(folder,seen,'2026-11-17T09:01:00+00:00'))
 def test_upload_persists_clock_without_changing_old_recordings(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);sid=str(uuid.uuid4());mid=str(uuid.uuid4());rec=Recorder(root,Store(),'rtmp://localhost','rtmp://localhost')
   rec.write({'id':sid,'match_id':mid,'parts':[],'error':None,'updated_at':'old'})
   folder=root/sid/'take-00001';folder.mkdir();one=folder/'part-000000.mp4';two=folder/'part-000001.mp4'
   one.write_bytes(b'x');two.write_bytes(b'y');(folder/'closed.csv').write_text('part-000000.mp4,0,30\npart-000001.mp4,30,60\n')
   (folder/'segment-received-times.json').write_text(json.dumps({one.name:'2026-11-17T09:00:00+00:00'}))
   with patch('app.recording_engine.subprocess.run',side_effect=OSError):rec.upload_closed(sid)
   parts=rec.load(sid)['parts'];self.assertEqual(parts[0]['first_frame_received_at'],'2026-11-17T09:00:00+00:00');self.assertIsNone(parts[1]['first_frame_received_at'])
   rows=parts_for_match(root,mid);self.assertEqual(rows[0]['parts'][0]['first_frame_received_at'],'2026-11-17T09:00:00+00:00');self.assertIsNone(rows[0]['parts'][1]['first_frame_received_at'])
 @unittest.skipUnless(shutil.which('ffmpeg'), 'ffmpeg is needed for the synthetic real-time recording')
 def test_recording_observes_new_segments_during_live_capture(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);source=root/'source.mp4';folder=root/'take-00001';folder.mkdir()
   subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=160x90:rate=10','-t','5','-c:v','libx264','-preset','ultrafast','-g','10',str(source)],check=True)
   command=capture_command(str(source),folder,2);command[command.index('-i'):command.index('-i')]=['-re']
   before=datetime.now(timezone.utc);proc=subprocess.Popen(command,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   stop=threading.Event();watcher=threading.Thread(target=watch_segment_starts,args=(folder,proc,stop));watcher.start()
   try:self.assertEqual(proc.wait(timeout=20),0)
   finally:stop.set();watcher.join(timeout=3);proc.kill() if proc.poll() is None else None
   times=json.loads((folder/'segment-received-times.json').read_text());self.assertGreaterEqual(len(times),2)
   stamps=[datetime.fromisoformat(t) for _,t in sorted(times.items())]
   self.assertTrue(all(before<=stamp<=datetime.now(timezone.utc) for stamp in stamps))
   self.assertGreater((stamps[1]-stamps[0]).total_seconds(),.5)
 def test_catalogue_rejects_naive_or_invalid_times(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);sid=str(uuid.uuid4());mid=str(uuid.uuid4());folder=root/sid;folder.mkdir()
   name='take-00001-part-000000.mp4';key=f'prelaunch/recordings/{mid}/{sid}/{name}'
   state={'id':sid,'match_id':mid,'parts':[{'name':name,'key':key,'duration':30,'first_frame_received_at':'2026-11-17T18:00:00'}]}
   (folder/'state.json').write_text(json.dumps(state));self.assertIsNone(parts_for_match(root,mid)[0]['parts'][0]['first_frame_received_at'])
