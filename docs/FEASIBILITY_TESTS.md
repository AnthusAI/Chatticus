# Feasibility tests

Decided designs in this repository rest on assumptions nobody has run.
Each test below answers one question that gates one decision. They are
research, not product: the code is throwaway and does not belong in
`python/src`.

Run these before building on the decisions they gate.

## How to use this file

- Each test states its question, the assumption under test, what it
  gates, a method, and what to do when it fails. A test without a written
  failure branch is not ready to run.
- When a test has run, record the result in the document it gates and
  delete the test from this file. This file holds open questions only.
- Spike code is disposable. Do not productionize it, do not add it to the
  quality gates, do not let it become the implementation.

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

Do it using challenge 1's transport result in
[Design challenges](DESIGN_CHALLENGES.md). Do not let it absorb the
spikes: a measurement that becomes a feature is a measurement nobody trusts.
