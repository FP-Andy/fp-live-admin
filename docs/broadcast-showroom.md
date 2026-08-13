# Broadcast showroom

`broadcast.fineludens.kr` is the public gallery and public asset origin for
FinePlay broadcast graphics. The gallery is intentionally separate from the
authenticated operations console, while image writes remain server-side or use
the protected FPC refresh endpoint. Assets are captured from the existing Live
Coder overlays at their native 1920×1080 composition, so the public image and
the operator's OBS graphic are the same visual source.

## Asset contract

The API creates the same graphic in two formats:

- PNG: conservative, lossless source for any broadcast system that accepts an
  image URL.
- Animated WebP: a short, looping entrance animation for OBS/browser-source
  overlays and the showroom.

During a live match, the following fixed URLs are replaced every minute:

```text
broadcast/{match_id}/live/attack-direction/latest.{png,webp}
broadcast/{match_id}/live/possession/latest.{png,webp}
broadcast/{match_id}/live/xg-shot-map/latest.{png,webp}
```

At 15, 30, 45, 60, 75 and 90 minutes the three live graphics are written to
immutable archive keys.  At 45 and 90 minutes a separate match-dominance asset
is written as well.  A completed 90-minute match therefore has 20 images in
each format: 18 live-graphic archive images plus half-time and full-time
dominance images.

## Public APIs

```text
GET  /api/broadcast/v1/live-matches
GET  /api/broadcast/v1/matches/{match_id}
POST /api/broadcast/v1/matches/{match_id}/refresh?finalize=false
```

The first two routes are public and provide the gallery with match metadata,
PNG URLs, WebP URLs and archive availability.  `refresh` requires
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
