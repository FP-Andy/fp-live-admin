"""Convert model boxes to visible image crops without changing floor evidence."""
import math


def visible_pixel_box(box, width, height):
    if len(box) != 4 or any(not math.isfinite(v) for v in box):
        raise ValueError('검출 박스의 좌표를 확인하세요.')
    # Tracker predictions can extend beyond the image even when detections do not.
    # Keep the raw track/footpoint intact; only the image crop is clipped here.
    return [max(0., min(float(limit), v * limit))
            for v, limit in zip(box, [width, height] * 2)]
