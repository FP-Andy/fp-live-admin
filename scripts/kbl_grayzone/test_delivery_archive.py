import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import delivery_archive as archive


class Unseekable:
    def __init__(self):
        self.buffer = io.BytesIO()
    def write(self, data):
        return self.buffer.write(data)
    def tell(self):
        return self.buffer.tell()
    def flush(self):
        pass


class DeliveryArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.case = {'gameNumber':'66','home':'원주 DB 프로미','away':'수원 KT 소닉붐',
                     'events':[{'id':'review-1','number':1},{'id':'review-2','number':2}]}
        self.pdf = self.root/'report.pdf'; self.pdf.write_bytes(b'%PDF-synthetic')
        self.folders = {}
        for n in (1, 2):
            folder = self.root/str(n); folder.mkdir(); self.folders[f'review-{n}'] = folder
            job = str(n)*24
            (folder/(job+'.json')).write_text(json.dumps({'poseMode':'map','playerOrientation':'map'}))
            (folder/(job+'.mp4')).write_bytes(f'video-{n}'.encode())
        self.patches = [patch.object(archive.case_store,'load_case',return_value=self.case),
                        patch.object(archive.report_versions,'latest_file',return_value=self.pdf),
                        patch.object(archive.review_videos,'folder',side_effect=lambda c,e:self.folders[e]),
                        patch.object(archive.review_videos,'inspect',side_effect=lambda c,e,j:({'poseMode':'map'},self.folders[e]/(j+'.mp4')))]
        for p in self.patches: p.start(); self.addCleanup(p.stop)

    def test_streamed_zip_contains_named_folder_pdf_and_all_scenes(self):
        result=archive.plan('game066-test'); stream=Unseekable();archive.write(result,stream)
        self.assertEqual(result['videoCount'],2)
        with zipfile.ZipFile(io.BytesIO(stream.buffer.getvalue())) as z:
            names=z.namelist();self.assertEqual(len(names),3)
            self.assertTrue(all(n.startswith('경기066-원주 DB 프로미 vs 수원 KT 소닉붐/') for n in names))
            self.assertTrue(any(n.endswith('경기 판독 리포트.pdf') and z.read(n)==b'%PDF-synthetic' for n in names))
            self.assertTrue(any(n.endswith('경기 판독 영상 01.mp4') and z.read(n)==b'video-1' for n in names))
            self.assertTrue(any(n.endswith('경기 판독 영상 02.mp4') and z.read(n)==b'video-2' for n in names))

    def test_missing_or_stale_video_does_not_create_a_partial_package(self):
        with patch.object(archive.review_videos,'inspect',side_effect=RuntimeError('stale')):
            with self.assertRaisesRegex(RuntimeError,'1, 2번'):archive.plan('game066-test')

    def test_comparison_video_is_not_silently_selected_as_standard(self):
        p=self.folders['review-2']/('2'*24+'.json');p.write_text(json.dumps({'poseMode':'refit'}))
        with self.assertRaisesRegex(RuntimeError,'2번'):archive.plan('game066-test')

    def test_missing_pdf_is_reported(self):
        with patch.object(archive.report_versions,'latest_file',side_effect=ValueError('missing')):
            with self.assertRaisesRegex(RuntimeError,'PDF'):archive.plan('game066-test')

    def test_http_download_streams_zip_without_a_temporary_archive(self):
        import threading
        from http.server import ThreadingHTTPServer
        from urllib.request import urlopen
        from serve import Handler
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        base=f'http://127.0.0.1:{server.server_port}/api/cases/game066-test/delivery-package'
        with urlopen(base) as response:
            self.assertEqual(json.load(response)['videoCount'],2)
        with urlopen(base+'.zip') as response:
            self.assertEqual(response.headers.get_content_type(),'application/zip')
            self.assertIn("filename*=UTF-8''",response.headers['Content-Disposition'])
            self.assertIsNone(response.headers.get('Content-Length'))
            payload=response.read()
        with zipfile.ZipFile(io.BytesIO(payload)) as z:
            self.assertEqual(len(z.namelist()),3)
            self.assertIsNone(z.testzip())
        self.assertFalse(list(self.root.glob('*.zip')))


if __name__=='__main__':unittest.main()
