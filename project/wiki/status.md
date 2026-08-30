# Status for returning agents (2026-08-30)

This page is the orientation snapshot. Kanbus issues are the record; this is the map.

## What this product is

Persistent named household AI teammates, one shared Linux computer per user, approvals, pull workers. Cloud API: no persistent sockets, turn-scoped SSE + POST, DynamoDB, computerless turns that can later escalate. Scale-to-zero is a requirement.

v1 LLM is OpenAI. Live model: **gpt-5.6-luna**. Key lives in `.env` (gitignored). CI uses the fake completion client.

## Branches

- `develop` is continuous integration. Merge accepted green work here. Open PRs against `develop`.
- `main` is the release branch. Semantic-release runs only from `main`.

## On develop

- SSE feasibility spike is on main (and therefore on develop); `ChatticusSseSpike` destroyed. Do not rebuild it. Do not destroy `ChatticusSnapshots` or `ChatticusComputers`.
- Mermaid computerless-turn diagram is in `docs/MESSAGING.md` (chatticus-f0f9e0 closed).
- Gherkin + FastAPI HTTP SSE thin turn is on `develop`. CI uses the fake OpenAI client.

## In flight (do this next)

| Issue | Status | Note |
| --- | --- | --- |
| chatticus-a78994 | open | **Next code:** live gpt-5.6-luna client + skippable pytest |
| chatticus-e5c86e | open | Deploy/exercise zero-idle turn |
| chatticus-387e4f | open | Spike done; mobile Safari still unmeasured |

## Do not

- Dual thread + channel APIs
- Merge failing behave to `develop` or `main`
- Start computer/browser/Vultus/Kanbus-cloud until the live model loop is proven (chatticus-a78994)
- Put secrets in git
- Treat in-process queue fan-out behind SSE as the deployed architecture
- Park accepted work on feature branches waiting for `main`

## AWS

Account `335163751677`, region `us-east-1`. CDK only in `infra/`.
