from io import BytesIO
import unittest
from unittest.mock import Mock
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from fpa_cv_remote_video import S3VideoReader,byte_range


class RemoteVideoTests(unittest.TestCase):
    def test_ranges_and_invalid_boundaries(self):
        self.assertEqual(byte_range(None,100),(0,99,False))
        self.assertEqual(byte_range('bytes=10-',100),(10,99,True))
        self.assertEqual(byte_range('bytes=20-999',100),(20,99,True))
        self.assertEqual(byte_range('bytes=-10',100),(90,99,True))
        for value in ('bytes=100-','bytes=10-9','bytes=-0','bytes=-','bytes=1-2,4-5'):
            with self.assertRaises(ValueError):byte_range(value,100)

    def test_decoder_reads_exact_ranges_and_closes_bodies(self):
        data=bytes(range(100));store=Mock();store.key.side_effect=lambda key:key
        store.bucket='bucket';store.head.return_value={'ContentLength':100};bodies=[]
        def get(**args):
            self.assertEqual(args['Key'],'key');start,end,_=byte_range(args['Range'],100)
            body=BytesIO(data[start:end+1]);bodies.append(body);return {'Body':body}
        store.client.get_object.side_effect=get
        with S3VideoReader(store,'key') as source:
            with urlopen(Request(source.url,method='HEAD')) as result:self.assertEqual(result.headers['Accept-Ranges'],'bytes')
            store.client.get_object.assert_not_called()
            for header,expected in [('bytes=20-29',data[20:30]),('bytes=-5',data[-5:])]:
                with urlopen(Request(source.url,headers={'Range':header})) as result:
                    self.assertEqual(result.status,206);self.assertEqual(result.read(),expected)
            with self.assertRaises(HTTPError) as error:urlopen(Request(source.url,headers={'Range':'bytes=100-'}))
            self.assertEqual(error.exception.code,416)
            with self.assertRaises(HTTPError):urlopen(source.url+'/wrong')
        self.assertEqual(source.bytes_read,15);self.assertTrue(all(body.closed for body in bodies))

if __name__=='__main__':unittest.main()
