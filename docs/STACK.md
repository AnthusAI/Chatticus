# Stack

v1 uses one language for the product brain. Do not add a second
implementation of the same behavior until the protocol is stable.

## Choices

| Layer | Choice | Why |
| --- | --- | --- |
| Agent, worker, API | Python 3.12+, FastAPI, OpenAI SDK, Playwright | OpenAI first; computer use; MCP clients; short Lambda edges |
| Web | TypeScript, Next.js, CloudFront | Chat, roster, computer preview, approvals |
| Computer image | Ubuntu, Xvfb, Chromium, noVNC | Same artifact on Fargate and local Docker |
| Data | DynamoDB, S3, Secrets Manager | Transcript, bots, and rules in DynamoDB; snapshots and files in S3; secrets out of the image. A relational instance is always on and would break scale-to-zero. |
| Cloud API | Per-request HTTP front door plus server-sent events scoped to one turn | No persistent sockets. Nothing bills while nobody is working. See [Messaging](MESSAGING.md). |
| Queues and schedules | SQS, EventBridge | Turns and heartbeats on SQS. EventBridge for routine wake-ups, worker starts, and device push. Neither is in the token path. |
| AWS compute | CDK. Computer hosts are Fargate (scale to 0). The control plane is per-request functions; placement is not settled. | Lambda for request-shaped work, including a stream held for one turn. Never a load balancer in front of the API: the hourly floor exceeds the container it replaces. |
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

**Also yes:** holding one turn's server-sent event stream. A turn is
request-shaped, seconds to minutes. Response streaming serves it, and the
client reconnects with `after=seq` if a turn outlives the function's
maximum duration.

**No:** computer use, VNC/display, anything that must hold a browser,
and any connection scoped to a chat tab or a login session.

State the premise, because the rule gets cited past its reason. Lambda is
excluded from these because it cannot hold a browser, a display, or a
session-lifetime connection. A turn phase that does none of those does
not touch the premise: a **computerless worker** running the
pre-computer part of a model loop is allowed, and is not the control
plane. See challenge 5 in [Design challenges](DESIGN_CHALLENGES.md).

## Rust

Not v1. Revisit a Rust worker daemon only if the Python heartbeat process is
too heavy on a Mac. Shared Gherkin is the door for that later.

## Local development

`docker-compose` will run a local DynamoDB, the control plane, and one
computer container so a laptop can be both the human surface and a local
worker. AWS is not required to prove routing, approvals, or a model turn
against a stub worker.

The Postgres service still in `docker-compose.yml` predates the DynamoDB
decision and is unused. Remove it when the local control plane lands.
