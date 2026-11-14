"""Request-scoped snapshots; never cache mutable work across HTTP requests."""
from contextvars import ContextVar
from functools import wraps
import copy

CURRENT=ContextVar('kbl_read_snapshot',default=None)

def scoped(fn):
    @wraps(fn)
    def call(*args,**kwargs):
        token=CURRENT.set({})
        try:return fn(*args,**kwargs)
        finally:CURRENT.reset(token)
    return call

def memoized(fn):
    @wraps(fn)
    def call(*args,**kwargs):
        cache=CURRENT.get()
        if cache is None:return fn(*args,**kwargs)
        key=(fn.__module__,fn.__name__,args,tuple(sorted(kwargs.items())))
        if key not in cache:cache[key]=fn(*args,**kwargs)
        return copy.deepcopy(cache[key])
    return call

def once(key,create):
    cache=CURRENT.get()
    if cache is None:return create()
    if key not in cache:cache[key]=create()
    return cache[key]
