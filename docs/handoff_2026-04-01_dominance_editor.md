# 2026-04-01 Handoff

## Summary

Today focused on archived match event editing and dominance visualization polish in both the archived editor and the live match page, while keeping existing partner-facing API behavior backward compatible.

## Key Constraints Kept

- Did not change existing default `/api/matches/{id}/dominance` response behavior for partner integrations.
- Added new dominance behavior behind `split_halves=true` so external parsing remains safe.
- Worked locally only. No production deployment in this session.

## Main Changes

### 1. Archived Match Event Editor polish

File:
- `apps/web/app/admin/match/[id]/edit/page.tsx`

Completed:
- Split event table and edit panel layout.
- Added scroll containment to event table card.
- Matched edit card height to table card and aligned sparse forms to the top.
- Switched clock editing from raw ms to `mm:ss`.
- Added `-1 / +1` second controls.
- Added midpoint insertion logic for new events between selected rows.
- Reused match-page xG half-pitch and xGOT goalmouth click UI.
- Aligned xG/xGOT inputs and estimate buttons.
- Simplified shot-speed control for compact layout.
- Changed attack lane editor to button-based selection matching match page.

### 2. Dominance editor tab

File:
- `apps/web/app/admin/match/[id]/edit/page.tsx`

Completed:
- Added `Dominance` tab next to `Events`.
- Added dominance chart + bin breakdown table.
- Added readable meta labels instead of `A1/H1`.
- Added goal annotations and HT annotation.
- Updated dominance visual style to:
  - single curve
  - orange above zero
  - blue below zero
  - white zero line
  - home goal half-line from `1 -> 0`
  - away goal half-line from `0 -> -1`

### 3. Match page dominance chart redesign

File:
- `apps/web/app/admin/match/[id]/page.tsx`

Completed:
- Applied same dominance visual language as editor page.
- Darkened grid lines so chart stands out more.
- Added home/away goal annotations and HT divider.
- Changed axis treatment to support split-half display.

### 4. Paused clock / phantom possession log bug fix

File:
- `apps/web/app/admin/match/[id]/page.tsx`

Completed:
- Prevented paused state from advancing internal clock.
- Prevented possession-log accumulation before timer start.
- Root cause was `perfRef` being treated as active clock baseline while match was paused.

### 5. Half-aware dominance binning

Files:
- `apps/api/app/main.py`
- `apps/web/app/admin/match/[id]/page.tsx`
- `apps/web/app/admin/match/[id]/edit/page.tsx`

Completed:
- Added optional `split_halves=true` support to:
  - `/api/matches/{id}/dominance`
  - `/api/v1/matches/{id}/dominance`
- New split-halves response keeps old default behavior untouched.
- Split logic:
  - first half binned independently
  - first-half stoppage time kept separate from second half
  - second half binned independently
  - second-half stoppage time also stays within second-half sequence
- Added response metadata/fields for UI rendering:
  - `split_halves`
  - `half_gap_ms`
  - `halves`
  - `ht_chart_ms`
  - per-bin `period`
  - per-bin `display_start_ms`, `display_end_ms`
  - per-bin `chart_start_ms`, `chart_end_ms`, `chart_midpoint_ms`

### 6. Half-aware axis labels

Files:
- `apps/web/app/admin/match/[id]/page.tsx`
- `apps/web/app/admin/match/[id]/edit/page.tsx`

Completed:
- Rendered dominance axis as:
  - `0 ~ 45+n | HT | 0 ~ 45+m`
- Added end ticks so stoppage-time bins do not visually collapse into the `45` tick.
- Changed end-of-half labels to `45+N` format instead of raw minute totals.

## Match/Data Used For Validation

Local cloned archived match:
- `c2f7bf37-40c1-458e-ad3f-41a534f22971`

Useful local URLs:
- `https://127.0.0.1/admin/match/c2f7bf37-40c1-458e-ad3f-41a534f22971`
- `https://127.0.0.1/admin/match/c2f7bf37-40c1-458e-ad3f-41a534f22971/edit`

## Validation Performed

- `python3 -m py_compile apps/api/app/main.py apps/api/app/services.py apps/api/app/models.py`
- `apps/web: ./node_modules/.bin/tsc --noEmit`
- Rebuilt local docker services repeatedly during iteration.
- Verified split-halves dominance response from local API.

## Deployment Notes For Tonight

- Deploy both `api` and `web` together.
- Important because `split_halves=true` now depends on new backend response fields.
- Default partner-facing dominance behavior remains unchanged unless `split_halves=true` is explicitly requested.

## Notion Follow-up

Could not update the Notion handoff database directly in this session because the Notion MCP connection returned `Auth required`.
When access is restored, this file can be copied into the handoff DB entry for 2026-04-01.
