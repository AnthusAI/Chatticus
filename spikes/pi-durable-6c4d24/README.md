# pi-durable on DynamoDB feasibility spike

Throwaway spike for Kanbus story `chatticus-6c4d24` (epic `chatticus-9f09c5`).
It asks whether `@earendil-works/pi-durable` can be the durable engine of a
Chatticus conversation, with its storage in DynamoDB and one short-lived
owner per turn. The design note is [`docs/PI_HARNESS.md`](../../docs/PI_HARNESS.md).

Nothing here touches AWS. Every script talks to a local DynamoDB endpoint
with dummy credentials. The model calls go to OpenAI `gpt-5-nano`.

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

# A local DynamoDB. Either moto (needs moto[server]; the repo venv lacks flask):
python3 -m venv /tmp/motovenv && /tmp/motovenv/bin/pip install "moto[server]==5.2.3"
/tmp/motovenv/bin/moto_server -p 5555
export PI_SPIKE_DYNAMODB_ENDPOINT=http://127.0.0.1:5555
# ...or Amazon DynamoDB Local:
# docker run -d --rm -p 8000:8000 amazon/dynamodb-local -jar DynamoDBLocal.jar -inMemory -sharedDb
# export PI_SPIKE_DYNAMODB_ENDPOINT=http://127.0.0.1:8000

npx tsc --noEmit
npx vitest --run test/dynamodb-storage.test.ts   # Phase 1

export OPENAI_API_KEY=...   # or it is read from /Users/home/Projects/Chattic.us/.env
node scripts/phase2-turns.ts
node scripts/handoff.ts
node scripts/phase3-crash.ts
node scripts/phase4-events.ts
node scripts/limits.ts
```

## What each piece proves

| File | Proves | Result file |
|---|---|---|
| `src/dynamodb-storage.ts` | pi-durable's `Storage` interface on one DynamoDB partition per storage, one `TransactWriteItems` per commit, an optional owner-fence condition on every commit | -- |
| `test/dynamodb-storage.test.ts` | pi-durable's own storage conformance suite passes against it | `conformance-moto.txt` |
| `scripts/phase2-turns.ts` | Owner 1 answers a turn and closes; owner 2 reopens and continues the conversation; a repeated `requestId` returns the original submission; a stale owner's commit and fence claim are rejected | `phase2-turns.json` |
| `scripts/handoff.ts` | A Lambda-like owner (no computer) admits the message, runs until the model calls `run_terminal`, parks the call and closes; a computer owner with the next fence resumes the same tool task, runs it once and finishes the turn; the Lambda's late commit is rejected | `handoff.json`, `handoff-executions.jsonl` |
| `scripts/phase3-crash.ts` | `SIGKILL` of a separate owner process mid model stream and mid tool call (replay `safe` and `unsafe`); a new owner resumes | `phase3-crash.json`, `phase3-*-executions.jsonl` |
| `scripts/phase4-events.ts` | `watchEvents()` batches per turn and their sizes; another participant's attributed message; an approval-style `beforeTool` block; a non-owner message delivered during a busy turn through a mailbox and admitted as a steer | `phase4-events.json` |
| `scripts/limits.ts` | The 100-item, 4 MB and 400 KB limits are detected and rejected before the transaction is sent | `limits.json` |

Commit latencies in the results are against a local emulator and say
nothing about DynamoDB in a region.
