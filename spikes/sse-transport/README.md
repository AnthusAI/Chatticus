# SSE transport feasibility spike

Throwaway spike for Test 1 in `docs/FEASIBILITY_TESTS.md`: Python Lambda
response streaming (Lambda Web Adapter) behind CloudFront, measured with a
browser `EventSource` harness.

## Deploy

```bash
cd infra
npm install
npx cdk deploy ChatticusSseSpike
```

If deploy fails on a 180 second CloudFront origin read timeout, retry with a
60 second timeout:

```bash
npx cdk deploy ChatticusSseSpike -c sseOriginReadTimeoutSeconds=60
```

Record the deployed origin read timeout from the `SseSpikeOriginReadTimeoutSeconds`
output.

## Run measurements

```bash
cd spikes/sse-transport
npm install
npx playwright install chromium

export SSE_SPIKE_DIRECT_URL="$(aws cloudformation describe-stacks \
  --stack-name ChatticusSseSpike \
  --query "Stacks[0].Outputs[?OutputKey=='SseSpikeFunctionUrl'].OutputValue" \
  --output text)"

export SSE_SPIKE_CLOUDFRONT_URL="$(aws cloudformation describe-stacks \
  --stack-name ChatticusSseSpike \
  --query "Stacks[0].Outputs[?OutputKey=='SseSpikeCloudFrontUrl'].OutputValue" \
  --output text)"

npm run measure
```

Results land in `results/`. For a manual check, open `harness/index.html` in a
browser, paste the CDK output URLs, and run the buttons.

Optional environment variables for `run-measurements.mjs`:

- `SSE_SPIKE_SHORT_DURATION_SECONDS` (default `60`)
- `SSE_SPIKE_LONG_DURATION_SECONDS` (default `120`)
- `SSE_SPIKE_RECONNECT_DURATION_SECONDS` (default `45`)
- `SSE_SPIKE_RECONNECT_AFTER_FRAMES` (default `20`)

## Mobile Safari checklist

This environment cannot produce real mobile Safari numbers. On a phone:

1. Deploy the spike and copy the CloudFront `/stream` URL.
2. Open `harness/index.html` from a local static server or host the harness
   somewhere reachable.
3. Paste the CloudFront URL, set duration to `120`, tap **Measure CloudFront**.
4. Repeat with the tab backgrounded.
5. Run the reconnect test after 20 frames.
6. Save the downloaded JSON into `results/mobile-safari-manual.json` if you
   want it in the repo.

## Destroy

```bash
cd infra
npx cdk destroy ChatticusSseSpike
```

## Notes

- Auth on the function URL is `NONE` for the spike only. Production will not
  do this.
- The spike Lambda timeout is 900 seconds so the direct path can observe the
  15-minute Lambda boundary.
- CloudFront is expected to disconnect near the origin read timeout (60 or 180
  seconds), not 15 minutes. Reconnect with `Last-Event-ID` is the intended path.
