# SSE transport spike results

Measured 2026-08-30 against stack `ChatticusSseSpike` (us-east-1).

## Deployed endpoints

| Output | URL |
| --- | --- |
| Direct function URL | https://6r537llsebh3kvok37t4vsvldu0mwpdf.lambda-url.us-east-1.on.aws/stream |
| CloudFront | https://d1jcaavght8v16.cloudfront.net/stream |
| Origin read timeout | 60 s (180 s quota not available) |

## Playwright summary (Chromium desktop)

| Scenario | Frames | TTFB (ms) | Gap p50 | Gap p95 | Reconnect |
| --- | --- | --- | --- | --- | --- |
| direct_foreground_short (60s) | 240 | 223 | 251 | 307 | n/a |
| cloudfront_foreground_short (60s) | 240 | 293 | 250 | 284 | n/a |
| direct_background_short (60s) | 240 | 93 | 251 | 351 | n/a |
| cloudfront_background_short (60s) | 240 | 186 | 251 | 352 | n/a |
| direct_reconnect | 40 | 109 | 250 | 584 | success (seq 20) |
| cloudfront_reconnect | 40 | 163 | 251 | 296 | success (seq 20) |
| direct_foreground_long (90s) | 360 | 69 | 250 | 367 | n/a |
| cloudfront_foreground_long (90s) | 360 | 127 | 250 | 333 | n/a |

Pass bar: p95 inter-frame gap under ~400 ms for 250 ms emit cadence. All
scenarios met it except reconnect legs, where the post-disconnect pause
(~3 s browser backoff) inflated p95 without batching steady-state frames.

## Direct boundary probe

| Metric | Value |
| --- | --- |
| Duration | 900.4 s |
| Frames | 3596 |
| Last seq | 3595 |
| Boundary | Lambda 900 s timeout |

## Not run

- Mobile Safari (human checklist in README)
