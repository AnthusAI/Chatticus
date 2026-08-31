# SSE transport spike results

Measured 2026-08-30 against stack `ChatticusSseSpike` (us-east-1).

## Deployed endpoints

Endpoints were CloudFormation outputs at measurement time. Record the
current function URL and CloudFront domain in gitignored `AGENTS.local.md`;
do not commit them.

| Output | Source |
| --- | --- |
| Direct function URL | `ChatticusSseSpike` `SseSpikeFunctionUrl` |
| CloudFront | `ChatticusSseSpike` `SseSpikeCloudFrontUrl` |
| Origin read timeout | 60 s (180 s quota not available) |

## Playwright summary (Chromium desktop, foreground)

| Scenario | Frames | TTFB (ms) | Gap p50 | Gap p95 | Material buffering | Reconnect |
| --- | --- | --- | --- | --- | --- | --- |
| direct_foreground_short (60s) | 240 | 223 | 251 | 307 | no | n/a |
| cloudfront_foreground_short (60s) | 240 | 293 | 250 | 284 | no | n/a |
| direct_reconnect | 40 | 109 | 250 | 584 | no | success (seq 20) |
| cloudfront_reconnect | 40 | 163 | 251 | 296 | no | success (seq 20) |
| direct_foreground_long (90s) | 360 | 69 | 250 | 367 | no | n/a |
| cloudfront_foreground_long (90s) | 360 | 127 | 250 | 333 | no | n/a |

Pass bar: p95 inter-frame gap under ~400 ms for 250 ms emit cadence. All
foreground scenarios met it. Reconnect p95 includes browser backoff after
server close, not transport batching.

`material_buffering` is true only when frames arrive in a same-tick burst
after a gap over one second (multi-second batch delivery). Rare same-tick
pairs alone do not count.

## Not run

- Real backgrounded tab
- Mobile Safari (human checklist in `../README.md`)

## Direct boundary probe

| Metric | Value |
| --- | --- |
| Duration | 900.4 s |
| Frames | 3596 |
| Last seq | 3595 |
| Boundary | Lambda 900 s timeout |
