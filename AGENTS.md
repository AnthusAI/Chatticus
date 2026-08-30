# AGENTS.md

Instructions for AI coding agents working on Chatticus.

## What this project is

Chatticus is a named-teammate product: persistent bots, a user-scoped Linux
computer, approvals, skills, routines, and a pull-based worker protocol that
can run the computer on AWS or on local hardware.

The public site and product name is **Chatticus** at **chattic.us**.

Do not describe this product as a clone, port, or copy of any third-party
agent product. Do not use third-party product names for Chatticus bots, the
computer, skills, routines, or the worker protocol.

v1's LLM is **OpenAI**. Amazon Bedrock may follow. Do not assume or add an
xAI client. The model vendor is not the product name.

## Layout

- `docs/` — product, architecture, stack, roadmap. Read these before changing
  control-plane or computer behavior.
- `features/` — shared Gherkin. Behavior changes start here.
- `python/` — control plane, scheduler, roster, approvals, later agent and
  worker processes.
- `web/` — Next.js app for chattic.us.
- `computer/` — Docker image for the Linux workplace.
- `infra/` — AWS CDK.

## Working rules

- No emojis in code, docs, commit messages, or Gherkin.
- No backward-compatibility forks or "support both ways" branches. One
  correct path. Migrate data; do not keep dual readers.
- Long, clear names. No line-level comments. Sphinx docstrings on public
  Python. Rustdoc later if a Rust worker appears.
- Gherkin in `features/` is the product narrative. Implement Python steps in
  `features/steps/` so `behave` from `python/` passes.
- `tenant_id` is required in worker registration, jobs, bots, and
  computers even while v1 has a single household tenant.

## Quality gates

From `python/` after `pip install -e ".[dev]"`:

```bash
black --check src ../features tests
ruff check src ../features tests
behave
pytest
```

Do not declare worker-protocol work done if `behave` or `pytest` is failing.

## Computer and Lambda

Do not put the agent loop, computer use, or the display on Lambda.

Lambda is allowed for HTTP, auth callbacks, inbound webhooks, and scheduled
wake-ups.

The computer is the Ubuntu image in `computer/`. The same image must remain
runnable on Fargate, EC2, and local Docker.

Durable computer disk is an S3 snapshot plus a local cache on the current
host. Do not mount S3 as the container root. Do not live-migrate containers.
Pack I/O lives in `python/src/chatticus/snapshot/`. See
`docs/COMPUTER_SNAPSHOTS.md`.

## Git

This repository is its own git repo. Do not commit Chatticus into the parent
`~/Projects` checkout.
