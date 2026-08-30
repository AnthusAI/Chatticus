# Stack

v1 uses one language for the product brain. Do not add a second
implementation of the same behavior until the protocol is stable.

## Choices

| Layer | Choice | Why |
| --- | --- | --- |
| Agent, worker, API | Python 3.12+, FastAPI, OpenAI SDK, Playwright | OpenAI first; computer use; MCP clients; short Lambda edges |
| Web | TypeScript, Next.js, CloudFront | Chat, roster, computer preview, approvals |
| Computer image | Ubuntu, Xvfb, Chromium, noVNC | Same artifact on Fargate and local Docker |
| Data | Postgres (RDS), S3, Secrets Manager | Computer snapshots and files in S3; secrets out of the image. Transcript store is [open](DESIGN_CHALLENGES.md). |
| Realtime API | Not chosen | Must stream tokens and should scale toward zero when idle. AppSync is out for the token pipe. See [Design challenges](DESIGN_CHALLENGES.md). |
| Queues and schedules | SQS, EventBridge | Turns, heartbeats, routines |
| AWS compute | CDK. Computer hosts are Fargate (scale to 0). The control-plane process that holds `/ws` is not placed yet. | Lambda only for seconds-long work, and not for the token socket. |
| BDD | behave and shared `features/` Gherkin | Product narrative lives in Gherkin |
| IaC | AWS CDK in TypeScript | Same language as the web app; every AWS resource lives in `infra/`. No console or ad-hoc CLI creates. |

## LLM providers

v1 talks to **OpenAI** (Chat Completions or Responses API with function
calling). The agent loop depends on a small provider interface so the rest
of Chatticus does not import a vendor SDK.

Amazon Bedrock is the next provider to consider. Do not add other vendors
until OpenAI turns work end to end.

## Lambda

**Yes:** auth callbacks, inbound webhooks, EventBridge "wake a routine",
cheap HTTP.

**No:** agent loop, computer use, VNC/display, anything that must hold a
browser. Holding a token stream for the life of a chat tab is part of
the [cloud API challenge](DESIGN_CHALLENGES.md), not a Lambda job.

## Rust

Not v1. Revisit a Rust worker daemon only if the Python heartbeat process is
too heavy on a Mac. Shared Gherkin is the door for that later.

## Local development

`docker-compose` will run Postgres, the control plane, and one computer
container so a laptop can be both the human surface and a local worker.
AWS is not required to prove routing, approvals, or a model turn against a
stub worker.
