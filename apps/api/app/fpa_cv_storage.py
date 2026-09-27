"""Private FPA objects. Reused verbatim by the GPU worker image."""
import os
import re
from functools import lru_cache
from pathlib import Path

KEY = re.compile(r'^fpa-cv/(uploads|jobs)/[0-9a-f]{32}/[\w.-]+$')

class FpaStorage:
    def __init__(self, client=None):
        self.bucket = os.getenv('FPA_CV_S3_BUCKET', '').strip()
        self.region = os.getenv('FPA_CV_S3_REGION', 'us-east-1')
        self._s3 = client
        self._accelerated = None

    @property
    def client(self):
        if self._s3 is None:
            self._s3 = self._make_client()
        return self._s3

    def _make_client(self, accelerate=False):
        import boto3
        import botocore.session
        from botocore.config import Config
        session = botocore.session.get_session()
        if os.getenv('FPA_CV_INSTANCE_ROLE') == '1':
            # Keep unrelated services' AWS credentials unchanged.
            credentials = session.get_component('credential_provider').get_provider('iam-role').load()
            if credentials is None:raise RuntimeError('FPA EC2 role credentials are unavailable')
            session._credentials = credentials
        return boto3.Session(botocore_session=session).client('s3', region_name=self.region,
            config=Config(signature_version='s3v4',connect_timeout=10,read_timeout=60,
                          s3={'use_accelerate_endpoint':accelerate},retries={'max_attempts':3,'mode':'standard'}))

    @property
    def upload_client(self):
        # Only browser PUTs cross continents. GPU transfers and GETs keep the
        # regional endpoint, avoiding acceleration fees for internal traffic.
        if os.getenv('FPA_CV_S3_ACCELERATE')!='1':return self.client
        if self._accelerated is None:self._accelerated=self._make_client(accelerate=True)
        return self._accelerated

    def key(self, value):
        if not self.bucket or not KEY.fullmatch(value):
            raise ValueError('Invalid FPA storage key')
        return value

    def head(self, key):
        return self.client.head_object(Bucket=self.bucket, Key=self.key(key))

    def url(self, key, expires=21600):
        return self.client.generate_presigned_url('get_object',Params={'Bucket':self.bucket,'Key':self.key(key)},ExpiresIn=expires)

    def download(self, key, path):
        from boto3.s3.transfer import TransferConfig
        path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
        part=path.with_suffix(path.suffix+'.part')
        try:
            self.client.download_file(self.bucket,self.key(key),str(part),Config=TransferConfig(max_concurrency=2))
            if part.stat().st_size != self.head(key)['ContentLength']:
                raise RuntimeError('Incomplete S3 download')
            part.replace(path)
        finally:
            part.unlink(missing_ok=True)

    def upload(self, path, key, content_type):
        from boto3.s3.transfer import TransferConfig
        path=Path(path)
        self.client.upload_file(str(path),self.bucket,self.key(key),ExtraArgs={'ContentType':content_type},Config=TransferConfig(max_concurrency=2))
        if self.head(key)['ContentLength'] != path.stat().st_size:
            raise RuntimeError('S3 output verification failed')

    def delete(self, key):
        self.client.delete_object(Bucket=self.bucket,Key=self.key(key))

    def begin(self, key, content_type):
        return self.client.create_multipart_upload(Bucket=self.bucket,Key=self.key(key),ContentType=content_type)['UploadId']

    def part_url(self, key, upload_id, number):
        return self.upload_client.generate_presigned_url('upload_part',Params={'Bucket':self.bucket,'Key':self.key(key),'UploadId':upload_id,'PartNumber':number},ExpiresIn=3600)

    def finish(self, key, upload_id, parts):
        self.client.complete_multipart_upload(Bucket=self.bucket,Key=self.key(key),UploadId=upload_id,MultipartUpload={'Parts':parts})

    def abort(self, key, upload_id):
        self.client.abort_multipart_upload(Bucket=self.bucket,Key=self.key(key),UploadId=upload_id)

@lru_cache(maxsize=1)
def storage():
    return FpaStorage() if os.getenv('FPA_CV_S3_BUCKET') else None
