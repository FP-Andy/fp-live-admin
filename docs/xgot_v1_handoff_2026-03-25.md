# xGOT v1 Handoff

Date: 2026-03-25

## Summary

This handoff captures the first production-ready xGOT v1 implementation added to the live admin tool.

## What Changed

- Added xGOT v1 backend storage fields on `events`
  - `xgot`
  - `is_on_target`
  - `goalmouth_x`
  - `goalmouth_y`
  - `is_header`
  - `is_weak_foot`
  - `shot_pace_band`
- Added `/api/xgot/estimate` and xG event recording support for xGOT metadata.
- Added goalmouth click UI to the match page.
- Added xGOT estimate field next to xG workflow.
- Added compact shot speed selector with `Slow`, `Normal`, `Fast`.
- Simplified xGOT controls:
  - kept `On Target`
  - kept `Goal`
  - kept `Header`
  - kept `Weak Foot`
  - removed `One-on-One`
  - removed `Under Pressure`

## Current xGOT v1 Logic

xGOT v1 is not a pure post-shot model. It is an xG-weighted post-shot model.

Current score:

```text
score =
  clipped_xg * 0.58
  + corner_factor * 0.24
  + placement_factor * 0.14
  + pace_factor
  - 0.03 if header
  - 0.02 if weak foot
  + 0.03 if goal
```

Where:

- `corner_factor` increases when the click is closer to the upper corners.
- `placement_factor` combines horizontal offset and height.
- `pace_factor` uses a fan-shaped weight from the center-bottom of the goalmouth.

## Important Behavior Notes

- `Fast` does not apply a flat bonus everywhere.
- Speed influence is intentionally weak in the keeper-zone near the center-bottom.
- Speed influence becomes stronger as the click moves upward and outward.
- Because xG is still weighted at `0.58`, low-xG chances can still cap xGOT even with strong placement.

## Known Interpretation Example

Example with:

- `xG = 0.10`
- `goalmouth = (0.964, 0.917)`
- `Shot Speed = Fast`

Current xGOT v1 result is about `0.455`.

Reason:

- xG base contributes `0.058`
- corner contribution contributes about `0.222`
- placement contributes about `0.129`
- fast speed adds about `0.046`

This is expected under the current formula and is not a bug.

## UI Decisions Finalized

- Team selector moved to the xG Input title row.
- `Record xG` moved next to the team selector.
- `xG` and `xGOT` labels were enlarged and bolded.
- Goalmouth zoom is shown above the half-pitch when `On Target` is enabled.
- Goalmouth coordinate text is rendered inside the lower-left of the goalmouth frame.
- Shot speed is rendered as a single compact selector instead of multiple large buttons.

## Production/Auth Notes

- Operator key was changed to `1234`.
- Superadmin key remains `dldydrms930**`.
- During deployment there was an env mismatch on `app-api`; resolved by force-recreating the API container.

## Next Suggestions

- Tune xG weight lower if we want post-shot placement to dominate more strongly.
- Add a document page for operators explaining what xGOT v1 means and how to use it.
- Revisit `Goal` bonus after enough data is accumulated.
