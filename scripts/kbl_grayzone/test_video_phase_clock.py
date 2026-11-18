import unittest
from video_jobs import PhaseClock

class PhaseClockTests(unittest.TestCase):
 def test_repeated_progress_does_not_reset_phase_timing(self):
  ticks=iter([0,1,3,8,10,13]);clock=PhaseClock(clock=lambda:next(ticks))
  clock.move('3D 장면 생성');clock.move('3D 장면 생성');self.assertEqual(clock.snapshot(),{'3D 장면 생성':2})
  clock.move('원본 영상과 연결');self.assertEqual(clock.snapshot(),{'3D 장면 생성':7,'원본 영상과 연결':2})
  clock.move('');self.assertEqual(clock.snapshot(),{'3D 장면 생성':7,'원본 영상과 연결':5})

if __name__=='__main__':unittest.main()
