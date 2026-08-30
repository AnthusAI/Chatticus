# Status for returning agents (2026-08-30)

This page is the orientation snapshot. Kanbus issues are the record; this is the map.

## What this product is

Persistent named household AI teammates, one shared Linux computer per user, approvals, pull workers. Cloud API: no persistent sockets, turn-scoped SSE + POST, DynamoDB, computerless turns that can later escalate. Idle floor is a requirement: nothing bills when nobody is working.

v1 LLM is OpenAI. Live model: **gpt-5.6-luna**. Key lives in `.env` (gitignored). CI uses the fake completion client.

## Branches

- `develop` is continuous integration. Merge accepted green work here. Open PRs against `develop`.
- `main` is the release branch. Semantic-release runs only from `main`. Current tag: **v0.2.0**.

## On main / develop

- README is written for a first-time reader. At every milestone, spawn a sub-agent to update Kanbus (comments, statuses, new issues) and README "What is live today".
- Computerless thin turn, Luna, SSE watch/reconnect, named-bot-without-computer: epic **467464 closed**.
- Turn **claim / lease / fence** is in git (`19eddc` closed). AWS **ChatticusThinTurn** has not been redeployed for that path (`ffcb11`).
- Do not destroy `ChatticusSnapshots` or `ChatticusComputers`. Do not rebuild `ChatticusSseSpike`.

## In flight (do this next)

| Issue | Status | Note |
| --- | --- | --- |
| chatticus-e42008 | open | Idempotent handoff, deadline, reconciliation |
| chatticus-ffcb11 | open | Redeploy ThinTurn so claim/fence is live |
| chatticus-b821ea | open | Interrupted work Gherkin (needs e42008) |
| chatticus-83b5e3 | open | Fault-inject boundaries (blocked by e42008) |
| chatticus-387e4f | open | Spike done; mobile Safari still unmeasured |

## Do not

- Dual thread + channel APIs
- Merge failing behave to `develop` or `main`
- Start computer/browser/Vultus until recovery on the computerless path is honest
- Put secrets in git
- Treat in-process queue fan-out behind SSE as the deployed architecture
- Park accepted work on feature branches waiting for `main`

## AWS

Account `335163751677`, region `us-east-1`. CDK only in `infra/`.
