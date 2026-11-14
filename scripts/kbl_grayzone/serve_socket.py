"""Private Courtside HTTP worker over a filesystem-protected Unix socket."""
import argparse,errno,fcntl,os,socket,socketserver,stat
os.environ.setdefault('KBL_VIDEO_RENDER_ENABLED','0')
from pathlib import Path
from serve import Handler,ROOT

class Server(socketserver.ThreadingMixIn,socketserver.UnixStreamServer):
    daemon_threads=True
    def get_request(self):
        connection,_=super().get_request()
        return connection,('127.0.0.1',0)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--socket',default='run/courtside.sock');args=parser.parse_args()
    path=(ROOT/args.socket).resolve()
    if not path.is_relative_to(ROOT) or path==ROOT:raise ValueError('socket must be inside shared root')
    path.parent.mkdir(parents=True,exist_ok=True)
    with (path.parent/(path.name+'.lock')).open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise RuntimeError('another Courtside worker owns this socket') from None
        # The FPC bridge reads the catalog before the first intake is created.
        # Initialize a new store before advertising the socket as ready.
        import match_library
        match_library.initialize()
        if path.exists():
            if not stat.S_ISSOCK(path.stat().st_mode):raise RuntimeError('socket path is occupied by a non-socket file')
            with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as probe:
                probe.settimeout(1)
                result=probe.connect_ex(str(path))
            if result not in (errno.ECONNREFUSED,errno.ENOENT):raise RuntimeError('socket may still be in use')
            path.unlink()
        previous=os.umask(0o077)
        try:server=Server(str(path),Handler)
        finally:os.umask(previous)
        identity=path.stat().st_ino
        print('Private Courtside socket ready',flush=True)
        try:server.serve_forever()
        finally:
            server.server_close()
            try:
                if path.stat().st_ino==identity:path.unlink()
            except FileNotFoundError:pass

if __name__=='__main__':main()
