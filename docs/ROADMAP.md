# Roadmap

## v1 — personal, shippable

- Web chat at chattic.us
- Named bots with isolated memory
- Threads and an append-only message store
- Realtime API (WebSocket on the control plane) for token streaming
- Bot-to-bot on the same thread (enqueue a turn, no bot-to-bot HTTP)
- One shared computer per user
- Model tool loop via OpenAI (MCP + browser on the computer)
- Approvals for send / publish / purchase / delete / production changes
- `/workspace` on the computer
- Worker protocol with `tenant_id` and prefer-local routing
- Computer snapshots: publish to S3, administrator relocate, host hydrate
- docker-compose for local control plane + computer
- Fargate (and optional EC2) path in AWS

This repository currently encodes v1 protocol behavior in Gherkin and an
in-memory Python control plane (routing, approvals, snapshot/relocate,
message store, realtime API fan-out). Hosts can pack and hydrate a workplace
through a filesystem object store or the CDK S3 bucket
(`ChatticusSnapshots`). The HTTP API, computer image, web app, and remaining
control-plane stacks are next.

## v2

- Routines (EventBridge)
- Skills
- Human takeover of the computer display
- Connector/plugin install flow
- Amazon Bedrock as a second LLM provider (optional)

## v3

- Teach-by-demonstration
- Multi-tenant auth and billing
- Desktop and iOS clients
- Optional Rust worker daemon
