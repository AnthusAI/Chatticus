# Computer image

The Chatticus computer is a long-lived Linux container. The same image runs
on ECS Fargate, stop/start EC2, and Docker on a Mac. Those are hosts. The
workplace identity and its snapshot live above them.

Build from the repository root:

```bash
docker build -f computer/Dockerfile -t chatticus-computer:dev .
```

Durable files live under `/var/lib/chatticus/computer/{workspace,browser-profiles}`.
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

Push a rebuilt image to ECR without changing the Computers service:

```bash
sh computer/push-computer-image.sh
```

Development live pin (chatticus-914eb7, partitioned browser profiles): see
[spikes/computer-browser-profiles/results/dev-image.json](../spikes/computer-browser-profiles/results/dev-image.json).

That packs on a Fargate-named container, hydrates onto a Mac-named
container, then the reverse. Stale files on the target host are dropped.

v1 contents:

- Debian slim with Node, git and CA certificates
- no display and no browser: the browser is an optional capability. A host
  that finds no Chromium or no Xvfb boots anyway, reports `browser_ready`
  false and `browser_unavailable` true, and the `browse` tool answers that the
  browser capability is not available on this computer. A larger image that
  adds Xvfb and Chromium back reports the browser ready at boot.
- shell and `/workspace`
- snapshot pack/hydrate CLI
- `node /opt/chatticus/host/host-worker.mjs` (bundled from `computer/host/`;
  RunTask may override the container command when `CHATTICUS_ECS_HOST_COMMAND`
  is set)
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
| Browser profile hydrated, display and Chromium up (optional; absent from the default image) | Browser actions |
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
