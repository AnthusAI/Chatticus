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

## What is not a feasibility test

The thin end-to-end turn -- human message, DynamoDB, model call, streamed
chunks, one committed message, no computer anywhere -- is the first build
step, not research. It runs on the computerless-worker path from
challenge 5 and is the smallest thing that is actually Chatticus.

Do it using challenge 1's transport result in
[Design challenges](DESIGN_CHALLENGES.md). Do not let it absorb the
spikes: a measurement that becomes a feature is a measurement nobody trusts.
