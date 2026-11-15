"""The AI comment template is source-bound and never pre-fills old text."""
import csv
from pathlib import Path
import tempfile
import unittest
from report_bundle import COMMENT_CSV_HEADERS, COMMENT_FIELDS, write_comment_template

class CommentTemplateTests(unittest.TestCase):
 def test_utf8_template_has_one_blank_row_per_saved_capture(self):
  self.assertEqual(COMMENT_CSV_HEADERS,('case_id','event_id','capture_id','case_revision','records_version','editorial_version',
   'focus','observation','difficultyFactors','viewComment','initialCall','decisionBasis','takeaway','assessment'))
  case={'id':'game-test','revision':3,'recordsVersion':'records-1','events':[{'id':'review-1'},{'id':'review-2'}]}
  with tempfile.TemporaryDirectory() as d:
   path=Path(d)/'comments.csv';write_comment_template(path,case,{'review-1':'abc','review-2':'def'},'version-1')
   self.assertTrue(path.read_bytes().startswith(b'\xef\xbb\xbf'))
   with path.open(encoding='utf-8-sig',newline='') as stream:
    reader=csv.DictReader(stream);self.assertEqual(tuple(reader.fieldnames),COMMENT_CSV_HEADERS);rows=list(reader)
   self.assertEqual([r['event_id'] for r in rows],['review-1','review-2'])
   self.assertEqual([r['capture_id'] for r in rows],['abc','def'])
   self.assertTrue(all(r['case_id']=='game-test' and r['editorial_version']=='version-1' for r in rows))
   self.assertTrue(all(r['case_revision']=='3' and r['records_version']=='records-1' for r in rows))
   self.assertTrue(all(not r[k] for r in rows for k in COMMENT_FIELDS))

if __name__=='__main__':unittest.main()
