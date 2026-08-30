# Status for returning agents (2026-08-30)

This page is the orientation snapshot. Kanbus issues are the record; this is the map.

## What this product is

Persistent named household AI teammates, one shared Linux computer per user, approvals, pull workers. Cloud API: no persistent sockets, turn-scoped SSE + POST, DynamoDB, computerless turns that can later escalate. Scale-to-zero is a requirement.

v1 LLM is OpenAI. Live model: **gpt-5.6-luna**. Key lives in `.env` (gitignored). CI uses the fake completion client.

## On main

- SSE feasibility spike merged; `ChatticusSseSpike` destroyed. Do not rebuild it. Do not destroy `ChatticusSnapshots` or `ChatticusComputers`.
- Mermaid computerless-turn diagram is in `docs/MESSAGING.md` (chatticus-f0f9e0 closed).
- Snapshot/routing/approval kernel remains.

## In flight (do this next)

Branch `cursor/durable-computerless-turn-4a21` at `341e42e`: Gherkin + FastAPI HTTP SSE thin turn. Manager accepted the HTTP SSE send-back. **Not merged.**

| Issue | Status | Note |
| --- | --- | --- |
| chatticus-a8f9d1 | in_progress | Specs accepted; merge with implementation |
| chatticus-df6e93 | in_progress | HTTP SSE accepted; close after main is green |
| chatticus-a78994 | open | **Next code:** live gpt-5.6-luna client + skippable pytest |
| chatticus-e5c86e | open | Deploy/exercise zero-idle turn after merge |
| chatticus-387e4f | open | Spike done; mobile Safari still unmeasured |

## Do not

- Dual thread + channel APIs
- Merge failing behave to main
- Start computer/browser/Vultus/Kanbus-cloud until the thin HTTP turn is on main
- Put secrets in git
- Treat in-process queue fan-out behind SSE as the deployed architecture

## AWS

Account `335163751677`, region `us-east-1`. CDK only in `infra/`.