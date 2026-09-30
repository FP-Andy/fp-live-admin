# Personal activity-density layer release

- Default target: +30 percentage points of the selected analysis interval. Optional +20pp and observed-only modes.
- Cap: eligible missing duration. No creation for a player with insufficient observed evidence; known outside/bench/inactive or manually filtered intervals remain excluded.
- Short gaps use constrained motion density; long gaps use that player's nearby observed distribution. This is an activity estimate, not reconstructed frame-by-frame truth.
- Original `positions`, `grid`, coverage, tracking identity, distance and events remain unchanged. A versioned `augmentation.estimatedGrid` and gap ledger are stored separately and validated at import and snapshot save.
- FPA shows observed and estimated amounts separately. FCM exports show `히트맵 반영률` (observed + estimated contribution, at most 100%) and the video interval. No test/augmentation/estimation notice is added to the report artwork. Comments continue to use observed coordinates and recorded events.
- Existing snapshots are immutable; rebuild the heatmap and save a new snapshot to use this layer. No YOLO analysis rerun or GPU deployment is needed.

## Real-data checks

Reused the two CV observation exports from the offline experiments. Original observations were byte-for-byte unchanged after generation; both the browser and API validators accepted all 20 player layers.

| Match | Mean observed | Mean added with 30pp target | Mean displayed |
|---|---:|---:|---:|
| Gwangju–Gyeongnam | 90.56% | 7.55pp | 98.11% |
| Ulsan–Jeonbuk | 76.99% | 18.58pp | 95.57% |

These are occupancy accounting checks, not identity/position accuracy gains. The existing masked-window experiments used CV proxy references, not independent human ground truth. In particular, long gaps and unknown substitutions can depart from the real movement pattern.
