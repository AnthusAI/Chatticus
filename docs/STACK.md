# Stack

v1 uses one language for the product brain. Do not add a second
implementation of the same behavior until the protocol is stable.

## Choices

| Layer | Choice | Why |
| --- | --- | --- |
| Agent, worker, API | Python 3.12+, FastAPI, OpenAI SDK, Playwright | OpenAI first; computer use; MCP clients; short Lambda edges |
| Web | TypeScript, Next.js, CloudFront | Chat, roster, computer preview, approvals |
| Computer image | Ubuntu, Xvfb, Chromium, noVNC | Same artifact on Fargate and local Docker |
| Data | Postgres (RDS), S3, Secrets Manager | Conversations and memory in Postgres; computer snapshots and files in S3; secrets out of the image |
| Queues and schedules | SQS, EventBridge | Turns, heartbeats, routines |
| AWS compute | API Gateway + Lambda for HTTP; ECS Fargate and optional stop/start EC2 for the computer | Lambda only for seconds-long work |
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
browser.

## Rust

Not v1. Revisit a Rust worker daemon only if the Python heartbeat process is
too heavy on a Mac. Shared Gherkin is the door for that later.

## Local development

`docker-compose` will run Postgres, the control plane, and one computer
container so a laptop can be both the human surface and a local worker.
AWS is not required to prove routing, approvals, or a model turn against a
stub worker.
