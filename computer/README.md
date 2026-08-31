# Computer image

The Chatticus computer is a long-lived Linux container. The same image runs
on ECS Fargate, stop/start EC2, and Docker on a Mac. Those are hosts. The
workplace identity and its snapshot live above them.

Build from the repository root:

```bash
docker build -f computer/Dockerfile -t chatticus-computer:dev .
```

Durable files live under `/var/lib/chatticus/computer/{workspace,browser-profile}`.
`/workspace` is a symlink to that workspace directory so bots and the
snapshot packer see the same tree.

Two hosts on one machine, sharing a snapshot store (not a live disk):

```bash
sh computer/test_relocate.sh
```

Run a computer on AWS Fargate (ARM64), hydrate its snapshot locally, then
scale the service back to 0:

```bash
sh computer/test_fargate.sh
```

That packs on a Fargate-named container, hydrates onto a Mac-named
container, then the reverse. Stale files on the target host are dropped.

v1 contents:

- Ubuntu
- Xvfb virtual displays (one screen per bot computer-use task)
- Chromium (in image; browser gate still unmeasured on cold start)
- shell and `/workspace`
- snapshot pack/hydrate CLI
- `python -m chatticus.computer_host_worker` (Chatticus package from `python/`;
  RunTask may override the container command when `CHATTICUS_ECS_HOST_COMMAND`
  is set; entrypoint starts Xvfb when `CHATTICUS_COMPUTER_BOOT=1`)
- noVNC (or equivalent) for watch and human takeover (next)
- `chatticus-worker` / `chatticus-agent` (next)

## Startup ordering

The agent must be able to answer while the workplace is still coming up.
Bring capabilities up independently and let `chatticus-agent` block only
on the one it needs:

| Gate | Needed for |
| --- | --- |
| Process and network | Model calls, memory, MCP and connector tools |
| `/workspace` hydrated | File actions |
| Browser profile hydrated, display and Chromium up | Browser actions |
| noVNC or equivalent | A human watching or taking over |

Do not serialize these behind one "ready" flag, and do not hold the agent
behind snapshot hydration. Hydration must finish before the first file or
browser action, not before the first model call.

Do not put this runtime on Lambda. It holds a browser, a display, and a
takeover surface, none of which Lambda can host. That is the reason, and
it does not extend to a computerless worker running the pre-computer part
of a turn. See challenge 5 in
[docs/DESIGN_CHALLENGES.md](../docs/DESIGN_CHALLENGES.md).

See [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) and
[docs/COMPUTER_SNAPSHOTS.md](../docs/COMPUTER_SNAPSHOTS.md).
