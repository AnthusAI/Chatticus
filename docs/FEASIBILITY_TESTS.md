# Feasibility tests

Decided designs in this repository rest on assumptions nobody has run.
Each test below answers one question that gates one decision. They are
research, not product: the code is throwaway and does not belong in
`python/src`.

Run these before building on the decisions they gate. Test 1 in
particular sits underneath the entire cloud API, and every other piece of
that design is downstream of it.

## How to use this file

- Each test states its question, the assumption under test, what it
  gates, a method, and what to do when it fails. A test without a written
  failure branch is not ready to run.
- When a test has run, record the result in the document it gates and
  delete the test from this file. This file holds open questions only.
- Spike code is disposable. Do not productionize it, do not add it to the
  quality gates, do not let it become the implementation.

## Test 1: Server-sent events through Lambda and CloudFront

**Question.** Can a Lambda function URL behind CloudFront hold a
server-sent event stream for the length of a model turn and deliver
250-millisecond chunks to a browser promptly, one at a time?

**Assumption under test.** That Lambda response streaming plus CloudFront
is a working token transport. This was reasoned about and never measured.

**What it gates.** Challenge 1 in
[Design challenges](DESIGN_CHALLENGES.md), which is to say the entire
cloud API. The per-request front door, the chunk buffer, the worker's
POST path, and the no-persistent-sockets rule all assume this works. If
it does not, they are built on the wrong transport.

**Why first.** It is the largest untested assumption in a decided design,
and it costs an afternoon. Everything else in the cloud API is downstream.

**Method.**

1. A Lambda with response streaming enabled, exposed by a function URL,
   responding `text/event-stream`.
2. It emits a numbered SSE frame carrying a server timestamp every 250
   milliseconds, for at least 20 minutes, so the 15-minute boundary is
   observed rather than assumed.
3. A CloudFront distribution in front of that function URL.
4. A browser page using `EventSource` that records client receive time
   per frame and prints the inter-frame gaps.
5. Measure **both** paths: straight to the function URL, and through
   CloudFront. The difference between them is the CloudFront buffering
   answer, which is the part most likely to disappoint.
6. Repeat with the tab backgrounded, and once on mobile Safari. The
   device-push story depends on knowing how a stream behaves when a tab
   is not focused.

**Pass criteria.**

- Frames arrive individually rather than in batches. For a
  250-millisecond emit cadence, a p95 client-side inter-frame gap under
  roughly 400 milliseconds.
- CloudFront does not add material buffering over the direct path.
- The stream either survives 15 minutes or ends at a predictable,
  documented boundary.
- Reconnect with `Last-Event-ID` resumes without loss.

**Known constraints to seed the spike.** These are documented limits of
the chosen transport, not speculation. The spike should test against them
rather than rediscover them.

- **Python is not a first-class streaming runtime.** AWS documents
  response streaming as native on Node managed runtimes. Python needs a
  custom runtime or the Lambda Web Adapter. The stack is Python, so the
  spike must use one of those, not the Node path.
- **CloudFront caps the origin connection well under 15 minutes.** The
  origin read timeout defaults to 30 seconds, has a standard maximum of
  60 seconds, and a hard maximum of 180 seconds (quota increase). A
  15-minute hold through CloudFront will not happen; reconnect-at-timeout
  is the real path, and 30 to 60 seconds is a normal turn. The spike's
  20-minute target is correct as a boundary probe, but the CloudFront
  path is expected to end near 180 seconds, not 15 minutes.
- **Function URL plus `Content-Encoding` has produced 502s behind
  CloudFront.** The known workaround is stripping `Accept-Encoding` at the
  edge (a viewer-request function) so the origin emits identity encoding.
  Build that into the spike distribution from the start.
- **CloudFront TTFB on function URLs has been reported around 500 to 800
  milliseconds** even with caching disabled. Measure it; it is the part
  most likely to push the p95 inter-frame gap over the pass criteria.

**If it fails.** Record which of these applies, then follow it.

- **CloudFront buffers.** Try the function URL directly with a custom
  domain, or an API Gateway HTTP API in front. Note which combination
  streams cleanly; the front door choice is still open in challenge 1, so
  this becomes an input to it rather than a crisis.
- **Lambda streaming is batchy.** The streaming host is wrong, not the
  design. Try, in order: an API Gateway streaming integration; then
  accept one small always-on streaming host and re-derive requirement 7
  for it explicitly rather than quietly abandoning it.
- **Nothing streams acceptably.** Challenge 1 reopens. The single
  always-on process, rejected on the multi-tenant argument, returns with
  a much stronger case, and this file's result is the evidence for it.

**Not in scope.** No DynamoDB, no model, no auth, no worker, no real
tokens. Synthetic frames on a timer. This tests the transport and nothing
else.

## Test 2: Cold start of the computer image

**Question.** On a cold Fargate task, how long from "start the computer"
to each readiness gate, and in particular to a browser that can accept a
command?

**Assumption under test.** That the wait is short enough to hide behind
the opening model call. Requirement 16 says a bot answers immediately;
non-requirement 3 says we will not optimize cold start. Those are only
compatible if the number is tolerable, and nobody has measured it.

**What it gates.** Requirement 16, non-requirement 3, and how urgent the
summoning work in challenge 5 really is.

**Method.**

1. Use the current image. Chromium is not in it yet, so either add it
   first or measure without and record the gap as an open component of
   the number.
2. `RunTask` on a cold Fargate ARM64 task definition, with no warm image
   cache on the host.
3. Timestamp each gate from challenge 5: task submitted, task RUNNING,
   agent process able to make a model call, `/workspace` hydrated,
   Chromium ready to accept a command.
4. Repeat about five times. Report the spread, not one number, and note
   whether image caching between runs is flattering the result.
5. Measure the same gates against warm local Docker, for the
   `prefer_local` comparison.

**Pass criteria.** There is no threshold to hit. The number is the
deliverable. The one thing that must hold is that **time to "agent can
make a model call" is seconds**, because that, not browser readiness, is
what requirement 16 actually depends on.

**How to read the result.**

- **Browser ready under about a minute.** The current plan stands.
  Nothing to do.
- **Two to four minutes.** Requirement 16 still holds, since the bot is
  talking, but a turn that needs the browser will feel broken. Image
  shrinking and lazy image loading move up the roadmap ahead of features.
- **Over about five minutes.** Declaring `computer` at enqueue stops
  being an optimization and becomes the normal path for any turn that
  might need a browser, and a warm host during active hours stops being
  optional.

**Not in scope.** Optimizing anything. This is a measurement, and
non-requirement 3 still says do not tune what has not been measured.

## What is not a feasibility test

The thin end-to-end turn -- human message, DynamoDB, model call, streamed
chunks, one committed message, no computer anywhere -- is the first build
step, not research. It runs on the computerless-worker path from
challenge 5 and is the smallest thing that is actually Chatticus.

Do it after Test 1, using Test 1's result to pick the transport. Do not
do it first, and do not let it absorb the spikes: a measurement that
becomes a feature is a measurement nobody trusts.
