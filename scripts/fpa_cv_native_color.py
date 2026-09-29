"""Use OpenCV's own libswscale for 10-bit GPU frames, retaining HDR metadata.

AVFrame's public prefix below is the libavutil 60 ABI (FFmpeg 8). Reject other
ABIs before accessing fields; the caller then uses its normal CPU fallback.
Only sampled frames cross the pipe. No video is recompressed for this bridge.
"""
import ctypes as C
import json
from pathlib import Path
import shutil
import subprocess


class Rational(C.Structure):
    _fields_ = [('num', C.c_int), ('den', C.c_int)]


class Frame(C.Structure):
    _fields_ = [('data', C.c_void_p*8), ('linesize', C.c_int*8), ('extended_data', C.c_void_p),
                ('width', C.c_int), ('height', C.c_int), ('nb_samples', C.c_int), ('format', C.c_int),
                ('pict_type', C.c_int), ('sample_aspect_ratio', Rational), ('pts', C.c_int64),
                ('pkt_dts', C.c_int64), ('time_base', Rational), ('quality', C.c_int), ('opaque', C.c_void_p),
                ('repeat_pict', C.c_int), ('sample_rate', C.c_int), ('buf', C.c_void_p*8),
                ('extended_buf', C.c_void_p), ('nb_extended_buf', C.c_int), ('side_data', C.c_void_p),
                ('nb_side_data', C.c_int), ('flags', C.c_int), ('color_range', C.c_int),
                ('color_primaries', C.c_int), ('color_trc', C.c_int), ('colorspace', C.c_int),
                ('chroma_location', C.c_int)]


def bind(lib, name, result, args):
    fn = getattr(lib, name);fn.restype=result;fn.argtypes=args;return fn


class NativeColor:
    def __init__(self, width, height, source):
        import cv2
        if width%2 or height%2:raise RuntimeError('10-bit 4:2:0 requires even dimensions')
        roots = sorted(Path(cv2.__file__).resolve().parent.parent.glob('opencv*.libs'))
        util_paths = [p for root in roots for p in root.glob('libavutil-*.so.60*')]
        sws_paths = [p for root in roots for p in root.glob('libswscale-*.so.9*')]
        if len(util_paths)!=1 or len(sws_paths)!=1:raise RuntimeError('OpenCV libavutil 60 / libswscale 9 bridge unavailable')
        self.util=C.CDLL(str(util_paths[0]));self.sws=C.CDLL(str(sws_paths[0]))
        if bind(self.util,'avutil_version',C.c_uint,[])()>>16!=60 or bind(self.sws,'swscale_version',C.c_uint,[])()>>16!=9:
            raise RuntimeError('Unsupported OpenCV colour ABI')
        ptr=C.POINTER(Frame);void=C.c_void_p
        self.allocate=bind(self.util,'av_frame_alloc',ptr,[])
        self.free=bind(self.util,'av_frame_free',None,[C.POINTER(ptr)])
        self.buffer=bind(self.util,'av_frame_get_buffer',C.c_int,[ptr,C.c_int])
        pixfmt=bind(self.util,'av_get_pix_fmt',C.c_int,[C.c_char_p])
        self.scale=bind(self.sws,'sws_scale_frame',C.c_int,[void,ptr,ptr])
        self.free_context=bind(self.sws,'sws_freeContext',None,[void])
        option=bind(self.util,'av_opt_set_int',C.c_int,[void,C.c_char_p,C.c_int64,C.c_int])
        self.context=None;self.src=None;self.dst=None;self.width=width;self.height=height
        try:
            meta=json.loads(subprocess.run([shutil.which('ffprobe') or 'ffprobe','-v','error','-select_streams','v:0',
                '-show_entries','stream=color_range,color_space,color_transfer,color_primaries,chroma_location','-of','json',str(source)],
                capture_output=True,text=True,timeout=15,check=True).stdout)['streams'][0]
            self.src=self.allocate();self.dst=self.allocate()
            if not self.src or not self.dst:raise MemoryError('Cannot allocate colour frames')
            for frame,fmt in [(self.src,b'yuv420p10le'),(self.dst,b'bgr24')]:
                frame.contents.width=width;frame.contents.height=height;frame.contents.format=pixfmt(fmt)
                if frame.contents.format<0 or self.buffer(frame,32)<0:raise RuntimeError('Cannot allocate colour plane buffers')
            for field,key,fn in [('color_range','color_range','av_color_range_from_name'),('colorspace','color_space','av_color_space_from_name'),
                                 ('color_primaries','color_primaries','av_color_primaries_from_name'),('color_trc','color_transfer','av_color_transfer_from_name'),
                                 ('chroma_location','chroma_location','av_chroma_location_from_name')]:
                if meta.get(key) not in (None,'unknown','unspecified'):
                    value=bind(self.util,fn,C.c_int,[C.c_char_p])(meta[key].encode())
                    if value<0:raise RuntimeError('Unsupported source colour metadata')
                    setattr(self.src.contents,field,value)
            self.context=bind(self.sws,'sws_alloc_context',void,[])()
            if not self.context:raise MemoryError('Cannot allocate colour context')
            if option(self.context,b'sws_flags',4,0)<0 or option(self.context,b'threads',2,0)<0:
                raise RuntimeError('Cannot configure OpenCV colour context')
        except BaseException:
            self.close();raise

    def convert(self, data):
        import numpy as np
        if len(data)!=self.width*self.height*3:raise RuntimeError('Incomplete 10-bit colour frame')
        offset=0
        for plane,(width,height) in enumerate([(self.width,self.height),(self.width//2,self.height//2),(self.width//2,self.height//2)]):
            size=width*height*2;stride=self.src.contents.linesize[plane]
            target=np.ctypeslib.as_array((C.c_uint8*(stride*height)).from_address(self.src.contents.data[plane])).reshape(height,stride)
            target[:,:width*2]=np.frombuffer(data,dtype=np.uint8,count=size,offset=offset).reshape(height,width*2)
            offset+=size
        if self.scale(self.context,self.dst,self.src)<0:raise RuntimeError('OpenCV colour conversion failed')
        stride=self.dst.contents.linesize[0]
        out=np.ctypeslib.as_array((C.c_uint8*(stride*self.height)).from_address(self.dst.contents.data[0])).reshape(self.height,stride)
        return out[:,:self.width*3].reshape(self.height,self.width,3).copy()

    def close(self):
        if self.context:self.free_context(self.context);self.context=None
        for name in ('src','dst'):
            frame=getattr(self,name,None)
            if frame:self.free(C.byref(frame));setattr(self,name,None)
