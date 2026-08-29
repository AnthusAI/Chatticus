# Computer image

The Chatticus computer is a long-lived Linux container. The same image runs
on ECS Fargate, stop/start EC2, and Docker on a Mac.

v1 contents:

- Ubuntu
- Xvfb virtual displays (one screen per bot computer-use task)
- Chromium
- shell and `/workspace`
- noVNC (or equivalent) for watch and human takeover
- `chatticus-worker` (register, heartbeat, pull turns)
- `chatticus-agent` (model tool loop)

Do not put this runtime on Lambda.

See [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).
