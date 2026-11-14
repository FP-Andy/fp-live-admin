"""Report typography can be supplied without publishing it as web content."""
from pathlib import Path
from unittest.mock import patch
import unittest
import report_assets

class ReportAssetsTests(unittest.TestCase):
 def test_absolute_override_and_default(self):
  with patch.dict('os.environ',{'COURTSIDE_REPORT_ASSETS':'/opt/private-report'}):
   self.assertEqual(report_assets.report_assets_dir(),Path('/opt/private-report'))
  with patch.dict('os.environ',{'COURTSIDE_REPORT_ASSETS':'relative'}):
   with self.assertRaises(ValueError):report_assets.report_assets_dir()
  with patch.dict('os.environ',{},clear=True):
   self.assertEqual(report_assets.report_assets_dir(),report_assets.ROOT/'apps/web/public/kbl-grayzone/assets/report-fonts')
if __name__=='__main__':unittest.main()
