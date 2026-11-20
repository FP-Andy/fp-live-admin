# Broadcast showroom

`broadcast.fineludens.kr` is the public gallery and public asset origin for
FinePlay broadcast graphics. The gallery is intentionally separate from the
authenticated operations console, while image writes remain server-side or use
the protected FPC refresh endpoint. Assets are captured from the existing Live
Coder overlays at their native 1920×1080 composition, so the public image and
the operator's OBS graphic are the same visual source.

## Asset contract

Each 1920×1080 graphic has three PNG URLs and an OBS browser-source URL in its manifest:

- `background_url`: the graphic's designed background layer.
- `asset_url`: the transparent data layer, for workflows that animate or
  control the layers separately.
- `combined_url`: both layers alpha-composited into one PNG. Pixels outside the
  graphic remain transparent; no checkerboard is baked into the PNG. Use this
  URL in an image source that supports alpha.
- `overlay_url`: a transparent HTML page containing that PNG, for OBS Browser
  Source. Set the source to 1920×1080. The page checks for updated data every
  15 seconds and retains the last graphic if the API is temporarily unavailable.
  Use the eye icon or scene controls to show or hide it.

The five live OBS URLs and both dominance URLs can be copied before a match
starts. They remain transparent until the corresponding graphic is generated;
the halftime and fulltime dominance graphics become available at their
respective checkpoints.

For consecutive UCCC games, `/overlay/uccc/<locator>` is a fixed set of seven
browser-source URLs. An authenticated operator selects the current match on
that match's FLA page or showroom page; the server verifies the operator's
write access and rejects a stale selection. A match handoff is explicit, not
based on clock or match creation order. OBS checks the selected match every 15
seconds, clearing the old image if the new match has not generated its image.
During network outages it retains the last successful image, so hide the source
until the current match can be confirmed. Dominance remains a full-screen
graphic when available.

Live graphics use a stable `combined.png` URL with a 55-second cache policy;
refreshing the image source picks up new data as it is generated. Archives
retain versioned URLs. For existing two-layer archives, the API serves a
combined PNG from their saved layers on request, without changing their source
images. The match-dominance graphic is a full-screen design, so its designed
background fills the frame.

The showroom preview uses a checkerboard to identify transparent areas. The
checkerboard is a UI background only. The image must be used as a PNG/image
source that supports transparency. Do not put a raw PNG URL into an OBS Browser
Source: the browser image viewer can paint its own gray background. Use the OBS
URL instead.

## Public APIs

```text
GET  /api/broadcast/v1/live-matches
GET  /api/broadcast/v1/matches/{match_id}
POST /api/broadcast/v1/matches/{match_id}/refresh?finalize=false
```

The first two routes are public and provide the gallery with match metadata,
the three PNG URLs and archive availability.  `refresh` requires
`X-Broadcast-Key`; FPC can call it right after a source-data update instead of
waiting for the minute worker.  Set `finalize=true` only after final match data
has been written, to ensure the 90-minute archive is captured.

## Required production environment

```dotenv
BROADCAST_PUBLIC_BASE_URL=https://broadcast.fineludens.kr
BROADCAST_S3_BUCKET=<public-assets-origin-bucket>
BROADCAST_S3_REGION=ap-northeast-2
BROADCAST_S3_PREFIX=broadcast
BROADCAST_CDN_BASE_URL=https://<cloudfront-distribution-domain>
BROADCAST_INGEST_KEY=<long-random-secret>
BROADCAST_ASSET_REFRESH_SECONDS=60
```

`BROADCAST_LIVE_CODER_RENDER_URL` defaults to the internal web renderer in the
compose stack. Its Chromium runtime is intentionally private to Docker; the
capture endpoint is not exposed through Nginx.

When S3 settings are omitted, assets stay in `/app/runtime/broadcast/assets`
and are served by the API; this is suitable for local development only.  In
production, set both `BROADCAST_S3_BUCKET` and `BROADCAST_CDN_BASE_URL`.  The
API uploads `latest` keys with `Cache-Control: public, max-age=55,
must-revalidate`; immutable archive keys use a one-year immutable cache.

Configure the CloudFront behaviour for the broadcast prefix with a minimum TTL
of zero so the 55-second origin header can take effect.  Keep the S3 bucket
private behind CloudFront Origin Access Control, but do not use signed viewer
URLs: the user-approved distribution URLs are public.

## Domain routing

After the `A`/`AAAA` or CNAME record for `broadcast.fineludens.kr` points to
the application/CloudFront origin and the certificate has been issued, add a
dedicated Nginx TLS server that proxies both routes to the existing containers:

```nginx
server {
  listen 443 ssl http2;
  server_name broadcast.fineludens.kr;

  ssl_certificate /etc/letsencrypt/live/broadcast.fineludens.kr/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/broadcast.fineludens.kr/privkey.pem;

  location /api/ {
    proxy_pass http://api:8000/api/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location / {
    proxy_pass http://web:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

`apps/web/middleware.ts` detects this hostname and rewrites `/` to the public
`/broadcast` route, so the operations console is never shown at the broadcast
domain.
