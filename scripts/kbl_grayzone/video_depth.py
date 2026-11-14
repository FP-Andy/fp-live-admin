"""Compile and load the small local rasterizer in a temporary build cache."""
import ctypes,hashlib,os,platform,shutil,stat,subprocess,tempfile,uuid
from pathlib import Path
import numpy as np

_lib=None
def cache_directory():
 configured=os.environ.get('KBL_RENDER_CACHE_DIR')
 if not configured:return Path(tempfile.gettempdir())
 path=Path(configured)
 try:
  info=path.lstat()
  if not path.is_absolute() or not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode & 0o077:raise ValueError()
 except (OSError,ValueError):raise RuntimeError('렌더 캐시 경로의 소유자와 접근 권한을 확인하세요.') from None
 return path

def library():
 global _lib
 if _lib:return _lib
 src=Path(__file__).with_name('video_depth_raster.cpp')
 key=hashlib.sha256(src.read_bytes()+platform.platform().encode()).hexdigest()[:20]
 path=cache_directory()/f'kbl-depth-{key}.so'
 if not path.exists():
  compiler=shutil.which('c++')
  if not compiler:raise RuntimeError('정확한 깊이 렌더링에 필요한 C++ 컴파일러가 없습니다.')
  tmp=path.with_name(path.name+'.'+uuid.uuid4().hex)
  try:
   subprocess.run([compiler,'-O3','-std=c++17','-shared','-fPIC',str(src),'-o',str(tmp)],check=True,capture_output=True,timeout=90)
   os.replace(tmp,path)
  finally:tmp.unlink(missing_ok=True)
 lib=ctypes.CDLL(str(path));ptr=ctypes.c_void_p
 lib.draw_depth.argtypes=[ptr,ptr,ptr,ctypes.c_int,ptr,ctypes.c_int,ctypes.c_int,ptr,ctypes.c_double]
 lib.draw_depth.restype=None;_lib=lib;return lib

def draw(image,vertices,faces,colors,K,near=.05):
 vertices=np.ascontiguousarray(vertices,dtype=np.float64);faces=np.ascontiguousarray(faces,dtype=np.int64)
 colors=np.ascontiguousarray(colors,dtype=np.uint8);K=np.ascontiguousarray(K,dtype=np.float64)
 if image.dtype!=np.uint8 or not image.flags.c_contiguous or image.ndim!=3 or image.shape[2]!=3:raise ValueError('렌더 이미지 형식을 확인하세요.')
 if faces.shape!=(len(colors),3) or vertices.ndim!=2 or vertices.shape[1]!=3 or K.shape!=(3,3):raise ValueError('렌더 삼각형 입력을 확인하세요.')
 if len(faces) and (faces.min()<0 or faces.max()>=len(vertices)):raise ValueError('렌더 인체의 삼각형 인덱스를 확인하세요.')
 h,w=image.shape[:2];library().draw_depth(vertices.ctypes.data,faces.ctypes.data,colors.ctypes.data,len(faces),image.ctypes.data,w,h,K.ctypes.data,float(near))
