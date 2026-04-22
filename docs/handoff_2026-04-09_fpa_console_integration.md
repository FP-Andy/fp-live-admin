# 2026-04-09 Handoff

## Summary

Today integrated FPA into the existing admin web as a second product inside `Fine Play Console`, instead of keeping FPA as a separately managed app.

The main goal was:

- keep existing FLA live-match operations intact
- expose FPA as a sibling product in the same console
- preserve original FPA input/export behavior where it materially affects operator workflow or analysis output

## Product Structure

The console now follows this hierarchy:

- `Fine Play Console`
  - `FLA`
    - `Dashboard`
    - `Media`
    - `System`
  - `FPA`
    - `Live Logger`
    - `File Analyzer`
    - `Visual Reports`
    - `Code Guide`

Primary web shell file:

- `apps/web/components/AdminShell.tsx`

## Main Changes

### 1. Top-level branding and navigation

Completed:

- Renamed the web shell branding to `Fine Play Console`
- Split sidebar navigation into product sections `FLA` and `FPA`
- Added product-aware page title and eyebrow handling

Relevant files:

- `apps/web/components/AdminShell.tsx`
- `apps/web/app/layout.tsx`
- `apps/web/app/manifest.ts`
- `apps/web/app/page.tsx`
- `apps/web/app/login/page.tsx`

### 2. FPA routes created inside the existing console

Completed:

- Added `Live Logger`
- Added `File Analyzer`
- Added `Visual Reports`
- Added `Code Guide`

Relevant files:

- `apps/web/app/admin/fpa/page.tsx`
- `apps/web/app/admin/fpa/live/page.tsx`
- `apps/web/app/admin/fpa/analyzer/page.tsx`
- `apps/web/app/admin/fpa/reports/page.tsx`
- `apps/web/app/admin/fpa/settings/page.tsx`

### 3. FPA backend logic moved into FastAPI

Completed:

- Reused the original FPA analysis logic inside the API app
- Added workbook generation endpoint for live logger export
- Added upload analysis endpoint
- Added player extraction endpoint
- Added pass map / heatmap endpoint

Relevant files:

- `apps/api/app/fpa.py`
- `apps/api/app/fpa_schemas.py`
- `apps/api/app/main.py`

### 4. Live Logger layout aligned to original FPA

Completed:

- Rebuilt the page layout to follow the original FPA work canvas order:
  - metadata row
  - recorded logs + field split panel
  - live controls row
- Removed the original temporary tab strip that was not actually used in this integrated product flow
- Restyled the page back into the existing console theme after matching layout

Relevant files:

- `apps/web/app/admin/fpa/live/page.tsx`
- `apps/web/app/globals.css`

### 5. Field image and coordinate system matched to original FPA

Completed:

- Replaced the CSS-drawn field with the provided field image
- Enforced official field coordinates `105 x 68`
- Matched the original FPA coordinate origin to bottom-left `(0,0)`
- Prevented clicks outside the field image by using the image area itself as the interaction region

Relevant files:

- `apps/web/public/fpa-field.png`
- `apps/web/app/admin/fpa/live/page.tsx`

Important coordinate rule:

- `x`: left to right, `0 -> 105`
- `y`: bottom to top, `0 -> 68`

### 6. Original FPA operator behavior parity restored

Completed:

- `-1/+1` time controls now move in `1 minute` steps, not `1 second`
- Arrow keys now match original FPA:
  - `ArrowUp`, `ArrowRight` => `+1 minute`
  - `ArrowDown`, `ArrowLeft` => `-1 minute`
- `Enter` submits the stat input
- Clicking the field focuses the stat input
- Right click on the field removes the last plotted coordinate
- Switching `Home/Away` automatically flips `Direction`

Relevant file:

- `apps/web/app/admin/fpa/live/page.tsx`

### 7. File Analyzer flow made closer to original FPA upload mode

Completed:

- Upload analysis now reads the `Data` sheet like the original FPA upload flow
- `File Analyzer` can now reuse the same uploaded file for:
  - analyzed Excel download
  - player extraction
  - pass map / heatmap generation

Relevant files:

- `apps/api/app/fpa.py`
- `apps/web/app/admin/fpa/analyzer/page.tsx`

## Validation Performed

- `apps/web: ./node_modules/.bin/tsc --noEmit`
- `python3 -m py_compile apps/api/app/main.py apps/api/app/fpa.py apps/api/app/fpa_schemas.py`
- rebuilt local docker services with:
  - `docker compose up -d --build api web nginx`
- verified local responses:
  - `https://127.0.0.1/admin/fpa/live`
  - `https://127.0.0.1/admin/fpa/analyzer`
  - unauthenticated requests redirect to `/login`
  - API `/health` returns OK

## Local Access Notes

Use:

- `https://127.0.0.1/login`

Do not rely on:

- `http://127.0.0.1:3000/...`

because current local nginx/domain behavior can redirect in a way that is less convenient for local product checks.

## Deployment Notes

- Deploy `api` and `web` together
- FPA web routes depend on new backend endpoints and workbook/visualization logic
- API image now depends on additional Python packages used by FPA analysis and plotting:
  - `python-multipart`
  - `pandas`
  - `numpy`
  - `openpyxl`
  - `matplotlib`
  - `mplsoccer`

## Constraints Kept

- Did not merge FPA data into existing FLA match state/event models
- Kept FPA under a separate `/api/fpa/*` namespace
- Preserved original FPA coordinate origin and operator shortcuts where they affect usability or data correctness
- Avoided destructive cleanup of the dirty worktree

## Follow-up Suggestions

1. Add a short `Code Guide` page that explains stat code grammar inside the integrated console
2. Decide whether `Visual Reports` should remain a separate page long-term, or be treated mainly as a deep-link alternative to `File Analyzer`
3. If production deployment is next, verify server image build time and package footprint after the new plotting dependencies
