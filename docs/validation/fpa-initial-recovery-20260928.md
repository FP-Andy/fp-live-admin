# Initial identity recovery validation — 2026-09-28

## Reproduction and cause

Three completed AWS jobs were tested offline, using their original tracks and server initial reviews. No YOLO inference, model change, threshold reduction, missing-time interpolation, or later human checkpoints were used. The baseline is f27cd9c.

All three contained a unique exact copy of the operator-selected initial box plus an almost identical unassigned detection (IoU 0.954–0.970). The legacy reciprocal-IoU margin rejected the selected box. `initial_review` then set `setup=null`, disabling identity reconnection for all players. The unmatched seeds were Ulsan home #4, Anyang home GK #20, and Suwon home GK #1.

## Results

Time-weighted usable heatmap coverage, averaged over the ten outfield roster slots; full original analysed clip, same quality exclusions before and after. This measures usable labelled observations, **not verified identity accuracy**.

| Match | Before | After | Initial seeds |
|---|---:|---:|---|
| 안양–대전 | 3.5% | 70.5% | 12 → 13 |
| 울산–전북 | 2.9% | 56.2% | 12 → 13 |
| 수원–대전 | 3.8% | 19.0% | 12 → 13 |

## Changes and safeguards

- Carry reviewed detection-row provenance into initial track assignments; remove only unassigned initial near-duplicate copies (IoU >= .95), retaining every human-selected box.
- Retain the manually selected initial observation even beyond the ROI margin, without treating its position as a valid heatmap coordinate.
- For legacy reviewed-frame results only, a unique coordinate-exact box restores its initial identity. Geometrically ambiguous results still abstain.
- A partial initial roster no longer disables recovery of observed identities. Missing identities are never invented.
- Existing result repair updates backed-up initial artifacts and job summary only. Operator reviews are never replaced. The UI fills only proven missing seed observations, respecting explicit assignments, exclusions and rejections, and preserves review rounds.
- Invalidate old browser recovery caches. Provide missing player names/numbers in future warnings.

## Remaining limitation and next bounded experiment

Suwon remains unsuitable for automatic reporting at 19.0%. During the first ten seconds of the initially labelled home tracks, the correct field-team colour wins with average field-team margins roughly 0.74–0.89, but mean absolute strength is only 0.079–0.101 against a fixed 0.10 floor. The five home tracks have 48/68, 93/146, 113/150, 80/150 and 103/150 null-team observations respectively. The black opposing goalkeeper kit also overlaps neutral pixels in other boxes. Merely reducing all thresholds risks claiming shadows, spectators, or the goalkeeper.

Next experiment: derive bounded team-specific colour evidence from the initial confirmed roster, test on separately confirmed later scenes, and compare identity errors as well as coverage. Keep motion, mutual assignment, collision and goalkeeper-role checks. This is not included in this deployment. Ulsan also retains long unassigned away-player intervals, so a corrected initialisation alone does not meet the five-scene heatmap goal for every match.

Gwangju (already 13/13 initialized) baseline coverage is 52.0%; this correction is not expected to solve its same-team ambiguity. No general identity-accuracy improvement is claimed from the coverage figures.

## Re-run

`node scripts/benchmark-fpa-cv-first-pass.mjs benchmark.json summary.json`, where the local input is `{tracks, review}`. Compare the baseline module with the current module and the repaired server initial review. Do not benchmark an edited Nth-round review as a first pass.

Validation: Python initial-seed tests (12), pipeline tests (7), job/API tests (24), and JS partial initialization, manual-review protection, checkpoints, checkpoint priority, review batching, goalkeeper context, heatmaps, and team conflict regressions pass. No full-video GPU reprocessing was needed.
