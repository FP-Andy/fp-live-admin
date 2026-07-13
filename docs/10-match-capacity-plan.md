# 10-Match Capacity Plan

## Goal

Korea Cup and WK Korea Cup operating days must support up to 10 simultaneous FLA stream matches without changing the external broadcast API contract or increasing the current 3-second operator polling delay.

This plan is based on match-day peak windows, not normal-day averages. The system can look very healthy on quiet days because stream matches are occasional. Capacity decisions must use the busiest 2-3 hour match window as the baseline.

## Non-Negotiables

- Do not change `/api/v1/*` response shape, field names, auth behavior, or webhook contract.
- Do not remove the existing `console.fineludens.kr/hls/...` compatibility path before confirming no broadcaster or operator workflow depends on it.
- Keep the Match Control operator refresh cadence at 3 seconds.
- Prefer media/gateway capacity and ffmpeg efficiency changes over API-side throttling.

## Current Findings

- `live-admin-app`: `t3.medium`, 2 vCPU / 4 GiB.
- `live-admin-media`: `c7i-flex.xlarge`, 4 vCPU / 8 GiB.
- During the 2026-06-20 peak stream window, media CPU stayed near 99% for roughly 18:30-20:50 KST.
- In the same window, media network stayed modest, with max observed 5-minute ingress around 20 Mbps.
- Therefore the primary 10-match bottleneck is media ffmpeg CPU, not app API, DB, or network.
- Normal-day CloudWatch averages are useful for cost and idle-state checks, but they are not valid sizing inputs for Korea Cup / WK Korea Cup stream days.

## Final Operating Plan

### Match Day Scale-Up

Use `c7i.4xlarge` for `live-admin-media` during 10-match operating windows, then scale back down or stop the media server after stream operations end.

- Current 7-match peak saturated 4 vCPU.
- 10 matches needs more than a linear 4 vCPU capacity envelope.
- `c7i.2xlarge` / `c7i-flex.2xlarge` is the minimum rehearsal tier.
- `c7i.4xlarge` is the recommended event-day tier because it leaves room for stream reattach, ffmpeg jitter, and operator retries.

Keep `live-admin-app` on `t3.medium` unless app CPU, DB wait, or memory pressure appears during a match-day rehearsal. Quiet-day app indicators are not enough by themselves, but the previous peak data points to media CPU as the first bottleneck.

### Gateway ffmpeg Mode

The gateway now defaults to audio stream copy:

```bash
FFMPEG_AUDIO_MODE=copy
```

This avoids per-match AAC audio transcoding on the media server. If a broadcaster feed has an audio compatibility issue, roll back only the audio mode:

```bash
FFMPEG_AUDIO_MODE=aac
```

Supported values:

- `copy`: copy input audio without transcoding. Default for capacity.
- `aac`: previous behavior, transcode to AAC 48 kHz 128 kbps.
- `none`: video-only HLS output.

Video remains copy-first:

```bash
FFMPEG_VIDEO_MODE=copy
```

## Rehearsal Checklist

1. Scale `live-admin-media` to `c7i.4xlarge`.
2. Start gateway compose and confirm `gateway-ffmpeg`, `gateway-rtmp`, `gateway-nginx` are up.
3. Confirm gateway env includes `FFMPEG_AUDIO_MODE=copy`.
4. Start 10 test streams with production-like source bitrate and audio codec.
5. Confirm each `/hls/<match_id>/stream.m3u8` becomes available.
6. Open 10 Match Control pages and keep the normal 3-second refresh.
7. Watch media CPU for at least 30 minutes.
8. Watch app CPU, app memory, Postgres memory, and API logs.
9. If a specific stream has no audio or playback compatibility issues, switch only `FFMPEG_AUDIO_MODE=aac` and retest that source class.
10. After the peak rehearsal window, scale media back down or stop it if no stream operations remain.

## Rollback

If the audio-copy change causes playback issues:

1. Set `FFMPEG_AUDIO_MODE=aac` on the media gateway.
2. Recreate `gateway-ffmpeg`.
3. Re-attach active streams.

This rollback does not change external API behavior or operator polling.

## Later Improvements

- Add CloudWatch Agent or a small internal metrics endpoint for media memory, disk, ffmpeg process count, and per-process CPU.
- Split media gateway into two origins and route 5 matches per origin.
- Keep app-side polling at 3 seconds, but consider visibility-aware polling only for inactive browser tabs.
