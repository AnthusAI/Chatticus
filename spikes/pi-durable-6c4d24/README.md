# pi-durable on DynamoDB feasibility spike

Throwaway spike for Kanbus story `chatticus-6c4d24` (epic `chatticus-9f09c5`).
It asks whether `@earendil-works/pi-durable` can be the durable engine of a
Chatticus conversation, with its data in S3 (one immutable object per
commit), a small index in DynamoDB, and one short-lived owner per turn. The design note is [`docs/PI_HARNESS.md`](../../docs/PI_HARNESS.md).

Nothing here touches AWS except the throwaway CDK app in `aws/`, which was deployed, measured and destroyed once with explicit approval (results in `results/aws/`, summary in `docs/PI_HARNESS.md`). Every script in `scripts/` talks to local DynamoDB and S3
endpoints (moto, path-style) with dummy credentials. The model calls go to OpenAI `gpt-5-nano`.

Packages are the published npm releases, pinned exactly:
`@earendil-works/pi-durable@1.0.2`, `@earendil-works/pi-ai@1.0.2`,
`@earendil-works/chord@1.0.2`. They match the Pi monorepo at `2003871`
(2026-10-04).

## Run

Node 22.19 or later (the spike ran on Node 26, which strips TypeScript types
natively).

```bash
cd spikes/pi-durable-6c4d24
npm install

# Local DynamoDB and S3: moto (needs moto[server]; the repo venv lacks flask).
python3 -m venv /tmp/motovenv && /tmp/motovenv/bin/pip install "moto[server]==5.2.3"
/tmp/motovenv/bin/moto_server -p 5555
export PI_SPIKE_DYNAMODB_ENDPOINT=http://127.0.0.1:5555 PI_SPIKE_S3_ENDPOINT=http://127.0.0.1:5555
# DynamoDB Local works for the DynamoDB side only:
# docker run -d --rm -p 8000:8000 amazon/dynamodb-local -jar DynamoDBLocal.jar -inMemory -sharedDb
# export PI_SPIKE_DYNAMODB_ENDPOINT=http://127.0.0.1:8000

# Owners use the S3-plus-index storage; PI_SPIKE_BACKEND=dynamodb selects the DynamoDB-only baseline.

npx tsc --noEmit
npx vitest --run test/   # Phase 1: conformance for both storages

export OPENAI_API_KEY=...   # or set CHATTICUS_ENV_FILE; the default is the repo-root .env
node scripts/phase2-turns.ts
node scripts/handoff.ts
node scripts/phase3-crash.ts
node scripts/phase4-events.ts
node scripts/limits.ts
node scripts/fence-loss.ts
node scripts/orphans.ts
node scripts/s3-conditional.ts
node scripts/cost.ts
```

## What each piece proves

| File | Proves | Result file |
|---|---|---|
| `src/indexed-storage.ts` | pi-durable's `Storage` with one immutable S3 object per commit (`conversations/<storage>/commits/<seq>-<fence>.json`, written with `If-None-Match: *`) and a DynamoDB index made visible by one `TransactWriteItems` with the sequence, fence and idempotency-token conditions | -- |
| `src/dynamodb-storage.ts` | The first version and cost baseline: every record body in DynamoDB | -- |
| `src/meter.ts` | Request-unit, S3 request and resident-storage estimates | -- |
| `test/indexed-storage.test.ts`, `test/dynamodb-storage.test.ts` | pi-durable's own storage conformance suite passes against both | `conformance-moto.txt` |
| `scripts/phase2-turns.ts` | Owner 1 answers a turn and closes; owner 2 reopens and continues the conversation; a repeated `requestId` returns the original submission; a stale owner's commit and fence claim are rejected | `phase2-turns.json` |
| `scripts/handoff.ts` | A Lambda-like owner (no computer) admits the message, runs until the model calls `run_terminal`, parks the call and closes; a computer owner with the next fence resumes the same tool task, runs it once and finishes the turn; the Lambda's late commit is rejected | `handoff.json`, `handoff-executions.jsonl` |
| `scripts/phase3-crash.ts` | `SIGKILL` of a separate owner process mid model stream and mid tool call (replay `safe` and `unsafe`); a new owner resumes | `phase3-crash.json`, `phase3-*-executions.jsonl` |
| `scripts/phase4-events.ts` | `watchEvents()` batches per turn and their sizes; another participant's attributed message; an approval-style `beforeTool` block; a non-owner message delivered during a busy turn through a mailbox and admitted as a steer | `phase4-events.json` |
| `scripts/fence-loss.ts` | Raising the fence while an owner is mid tool call: its next commit fails with `OwnershipLost` (not `StorageRejected`), the poisoned owner makes no further commit, tool start or model request, and the next owner finishes the turn | `fence-loss.json`, `fence-loss-executions.jsonl` |
| `scripts/limits.ts` | The 100-item limit is rejected before sending on both storages; the 400 KB item and 4 MB transaction limits only bind the DynamoDB-only storage | `limits-indexed.json`, `limits-dynamodb.json` |
| `scripts/orphans.ts` | A rejected or fenced-out commit leaves no S3 object; a crashed attempt's object at the same key is replaced; a reference sweeper deletes unreferenced objects only when META.seq >= seq or OWNER.fence > fence | `orphans.json` |
| `scripts/s3-conditional.ts` | moto honors `If-None-Match: *` (412 on overwrite) | `s3-conditional.json` |
| `scripts/cost.ts` | One plain and one tool turn on each storage: request units, S3 requests, resident bytes, reopen and transcript-read cost | `cost.json` |

Commit latencies and request counts in the results come from a local
emulator. Latencies say nothing about AWS in a region; request units are
estimates (moto reports no consumed capacity).
