"""Bound encoder, decoder and filter parallelism without changing media quality."""
import os
import subprocess
from pathlib import Path


def ffmpeg_args(args):
    if not args or Path(str(args[0])).name != 'ffmpeg':
        return args
    def threads(name, default):
        return str(max(1, min(8, int(os.getenv(name, default)))))
    result = [args[0], '-filter_threads', threads('HIGHLIGHT_FILTER_THREADS', '1'),
              '-filter_complex_threads', threads('HIGHLIGHT_FILTER_THREADS', '1')]
    for arg in args[1:-1]:
        if arg == '-i':
            result += ['-threads', threads('HIGHLIGHT_DECODE_THREADS', '1')]
        result.append(arg)
    result += ['-threads:v', threads('HIGHLIGHT_CODEC_THREADS', '2'), args[-1]]
    return result


def run_media(args, **kwargs):
    return subprocess.run(ffmpeg_args(args), **kwargs)
