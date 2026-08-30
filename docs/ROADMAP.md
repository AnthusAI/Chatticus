# Roadmap

## v1 — personal, shippable

- Web chat at chattic.us
- Named bots with isolated memory
- One shared computer per user
- Model tool loop via OpenAI (MCP + browser on the computer)
- Approvals for send / publish / purchase / delete / production changes
- `/workspace` on the computer
- Worker protocol with `tenant_id` and prefer-local routing
- Serverless control plane: per-request HTTP, one-turn server-sent events,
  DynamoDB transcript
- Computer snapshots: publish to S3, administrator relocate, host hydrate
- docker-compose for local control plane + computer
- Fargate (and optional EC2) path in AWS

This repository currently encodes worker routing, approvals, and
snapshot/relocate in Gherkin and an in-memory Python control plane.
Hosts can pack and hydrate a workplace through a filesystem object store
or the CDK S3 bucket (`ChatticusSnapshots`).

The cloud API and the message store are now **decided**: a per-request
front door, server-sent events scoped to one turn, and DynamoDB. See
[Messaging](MESSAGING.md) for the design and
[Design challenges](DESIGN_CHALLENGES.md) for the reasoning. Channels
and bot-to-bot addressing are still open, as are parts of compaction.
The messaging kernel predates these decisions; it is a transport-agnostic
protocol sketch, not the schema.

## v2

- Routines (EventBridge)
- Skills
- Human takeover of the computer display
- Connector/plugin install flow
- Amazon Bedrock as a second LLM provider (optional)

## v3

- Teach-by-demonstration
- Multi-tenant auth and billing. The *features* are v3; the *seam* is a
  v1 requirement. Serving other households is a commitment, not a door
  left open, and the architecture is held to it now.
- Desktop and iOS clients
- Optional Rust worker daemon
