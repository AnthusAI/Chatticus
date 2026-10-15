# Spike: hand a Pi session to a computer owner

Throwaway code. It does not belong in `conversation/src`. It answers one question:
can a pi-durable session move from one owner to another owner, and finish in a
container that runs Pi's own coding tools? The answers are in
[docs/PI_HARNESS.md](../../docs/PI_HARNESS.md), section "Spike: handoff to a computer owner".

## Terms

- **A**: the Lambda-like owner. It registers park tools. It cannot run a computer tool.
- **B**: the container-like owner. It registers local tools (pi-durable `read`, `write`,
  `edit`, `bash`) that run on its own disk.
- **A2**: a second Lambda-like owner. It handles the next message of the same conversation.

Each owner is a separate Node process. They share only the storage on moto.

## What you need

- Node 24 or later (the code runs as TypeScript with type stripping).
- `npm ci` at the repository root.
- Docker. No AWS access.
- `OPENAI_API_KEY` in the environment, only for the one real-model run.

## Start moto

```sh
lsof -i :5622
docker run -d --rm --name moto-spike -p 5622:5000 motoserver/moto:5.2.3
export CHATTICUS_TEST_AWS_ENDPOINT=http://127.0.0.1:5622
```

The port must be free first. Stop the container when you finish: `docker stop moto-spike`.

## Phase 1: in process (separate processes, no container)

Raw scenario. It uses pi-durable and the production session storage. No control plane.

```sh
cd spikes/pi-handoff
SPIKE_MODEL=faux node scripts/run-raw.ts safe unsafe missing schema
SPIKE_MODEL=openai node scripts/run-raw.ts safe
```

- `faux` uses the scripted provider. `openai` uses gpt-5-nano.
- Variants change what B registers. `safe`: same names, `replay: "safe"`.
  `unsafe`: the tools as shipped. `missing`: no tools. `schema`: another schema for `write`.
- A parks on the first tool call and closes. B opens the storage, resubmits the same
  request id and finishes. A2 answers a follow-up.

Executor scenario. It runs the production turn executor with real Dynamo stores and a
seeded bot, channel and message. A runs the unchanged executor. B runs it with one seam.

```sh
node scripts/make-seamed-executor.mjs
node scripts/run-executor.ts
```

`make-seamed-executor.mjs` prints the diff of the seam. It writes `generated/`, which git ignores.

Other checks:

```sh
node scripts/env-leak-check.ts
cd coding-agent-probe && npm ci && node probe-tools.mjs
```

The probe installs `@earendil-works/pi-coding-agent` 1.0.4 in its own directory.
The root workspace stays unchanged.

## Phase 2: B in a container

```sh
./scripts/build-container.sh
docker build -t pi-handoff-spike:phase2 .
docker network create spike-net
docker network connect spike-net moto-spike
export SPIKE_DOCKER_NETWORK=spike-net
SPIKE_B_DOCKER=pi-handoff-spike:phase2 SPIKE_MODEL=faux node scripts/run-raw.ts safe
SPIKE_B_DOCKER=pi-handoff-spike:phase2 node scripts/run-executor.ts
```

- The image is arm64, `node:22-bookworm-slim` plus git. It runs as user `node`.
- B reaches moto over a user-defined Docker network. Without `SPIKE_DOCKER_NETWORK` the
  runner uses `host.docker.internal`. That path was unreliable on Docker Desktop.
- The runner prints the cold-start timing and `docker cp`s the file from the container disk.

## Clean up

```sh
docker rm -f $(docker ps -aq --filter name=spike-)
docker rmi pi-handoff-spike:phase2
docker network rm spike-net
docker stop moto-spike
```

## Files

| Path | Purpose |
|---|---|
| `src/owner-raw.ts` | Owner process for the raw scenario (roles `a`, `b`, `a2`). |
| `src/owner-executor.ts` | Owner process that runs the production executor. |
| `src/local-tools.ts` | B's computer tools: same schemas, pi-durable built-ins, action ledger. |
| `src/executor-world.ts` | Dependencies and seeding, the way the Lambda builds them. |
| `src/common.ts` | Moto clients, journal, AWS call recorder. |
| `scripts/` | Coordinators, the seam generator, the container build. |
| `results/` | Output of the runs quoted in the docs. |
