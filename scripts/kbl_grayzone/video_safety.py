"""Preserve the position-only meaning of current and legacy wide references."""
def position_only(entity):
    if entity.get('positionOnly') is True:return True
    return entity.get('role')=='referee' and (entity.get('roleSource')=='wide-manual-evidence' or entity.get('positionSource')=='wide-manual-estimate')

def has_position_only(scene):
    return any(position_only(e) for e in scene.get('state',{}).get('entities',[]))
