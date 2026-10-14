"""Remove crop-edge fragments without averaging body and shadow geometry."""


def remove_crop_fragments(rows, bounds, teams=None, tolerance=2.5):
    teams = teams or [None] * len(rows)
    if len(teams) != len(rows):
        raise ValueError('Every detection must have one team entry')
    # An internal edge must lie inside another crop, not on the outer court ROI.
    edges = {edge for i, tile in enumerate(bounds) for edge in (tile[0], tile[2])
             if any(j != i and other[0] < edge < other[2] for j, other in enumerate(bounds))}
    kept = []
    for i, a in enumerate(rows):
        width, height = a[2] - a[0], a[3] - a[1]
        cuts = [edge for edge in edges if min(abs(a[0]-edge), abs(a[2]-edge)) < tolerance]
        truncated = False
        if cuts and width > 0 and height > 0:
            for j, b in enumerate(rows):
                if i == j or b[4] < max(.25, a[4]*.7):
                    continue
                if teams[i] and teams[j] and teams[i] != teams[j]:
                    continue
                overlap = max(0, min(a[2], b[2])-max(a[0], b[0])) * max(0, min(a[3], b[3])-max(a[1], b[1]))
                if b[2]-b[0] < width*1.3 or b[3]-b[1] < height*.8 or overlap/(width*height) < .85:
                    continue
                if any(b[0] < edge-tolerance and b[2] > edge+tolerance for edge in cuts):
                    truncated = True
                    break
        if not truncated:
            kept.append(a)
    return kept
