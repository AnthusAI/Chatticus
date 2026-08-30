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

That packs on a Fargate-named container, hydrates onto a Mac-named
container, then the reverse. Stale files on the target host are dropped.

v1 contents:

- Ubuntu
- Xvfb virtual displays (one screen per bot computer-use task)
- Chromium (next)
- shell and `/workspace`
- snapshot pack/hydrate CLI
- noVNC (or equivalent) for watch and human takeover (next)
- `chatticus-worker` / `chatticus-agent` (next)

Do not put this runtime on Lambda.

See [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) and
[docs/COMPUTER_SNAPSHOTS.md](../docs/COMPUTER_SNAPSHOTS.md).
