# Goalkeeper context in identity review

The review/reconnection pass now establishes keeper roles before comparing field-team colours. It derives the goal axis from the calibrated court and the earliest manual observations of both keepers. No match, timestamp, track ID or kit colour is built into the algorithm. Without valid court/keeper anchors it retains the previous colour-only behaviour.

Observed keeper paths continue through plausible motion, including forward movement away from goal. New IDs require separated motion/appearance evidence or sustained compact observations near the assigned goal; proximity alone never assigns a keeper. Ambiguous crowded candidates remain unassigned. Later manual keeper/field observations override the path. No positions are interpolated or invented.

For other players, home/away/referee colours compete separately from keeper palettes. A distinctive keeper colour without a trusted role path remains unresolved. Role conflicts can close an inherited field identity even within the same team. The same evidence is used in continuity, checkpoint recovery, labels, recommendations and heatmap filtering, and survives worker/cache round trips. The recovery cache version is bumped. Raw YOLO/ByteTrack outputs and operator review records are unchanged; existing results can be reconnected without another GPU analysis.

## Validation

- Ten Node regression suites cover roster recovery, occlusion and identity switches, continuity, checkpoints, batch review, heatmaps, recommendation UI, and the new keeper logic. New cases include matching keeper/field kits, a closer attacker, ambiguous set pieces, a flying keeper, ID replacement, rotated/missing calibration, a manual field correction and cache persistence.
- Read-only comparison on the existing 광주–경남 dataset: all 372 home-field observations in the first five seconds changed from colour-unresolved to home. At 262.60 seconds, track 3387 changed from the wrong home-keeper colour classification to away keeper.
- End-to-end reconnection on the original initial-only review, from 45.512 to 270 seconds: track 3387 regained away keeper No.1. Track 3265 changed from an away-field assignment to a home-field candidate. Home assigned observation-time rose from 232.83 to 734.87 player-seconds; away keeper from 5.21 to 220.15 seconds. These are coverage/assignment measurements, **not ground-truth identity accuracy**. The full match and the user's later review rounds were not used to claim an accuracy percentage. Other unresolved field tracks remain for human review.
- On the local comparison, the bounded reconnection took 39.0 seconds before and 33.8 seconds after; this is not a speed guarantee. Keeper-context construction over the full stored match took approximately 2.3 seconds.
