# chatticus-3d5357 — EFS in-VPC metadata latency

Throwaway AWS lab: one General Purpose EFS + one AL2023 EC2 in the
ChatticusComputers VPC (`vpc-0c5a0f0ca21e2afdd`), same AZ as the mount target.
Control = **local EBS on the same instance**. Fixture matches A0
(`spikes/nfs-wan-netem-9af381/`).

Kanbus: `chatticus-3d5357`. Does **not** close the card.

## Question

Is EFS fast enough in-VPC for a hot `/workspace`?

## Thresholds (frozen, vs EBS on same instance)

| Warm ratio vs EBS | Verdict |
| --- | --- |
| ≤ ~3× | Proceed |
| 3–10× | Marginal |
| > 10× | D1 fails for `/workspace` |

Do **not** treat A0 WAN numbers as in-VPC prediction.

## Phases

1. **EBS control** — A0 `run_ops` medians (mutating).
2. **Read-only sweep** — `git status` × 20 per actimeo; remount between actimeo; no `drop_caches` between warm iterations; RPC deltas per iteration.
3. **Mutating sweep** — A0 `run_ops` per actimeo (separate table).

## Run (from worktree)

```bash
cd spikes/efs-invpc-3d5357
chmod +x scripts/*.sh
./scripts/run-spike.sh
```

`run-spike.sh` creates tagged resources, runs the bench via SSM (no SSH, no S3),
fetches results, and **always destroys** spike resources on EXIT.

## Guards

- Never touch Kanbus EFS `fs-09fcbd58a2e2d2c98`
- Never `cdk destroy` or modify `ChatticusComputers` / `ChatticusSnapshots`
- `desiredCount` stays 0
- Tag: `chatticus-3d5357`

## Results

See [results/README.md](results/README.md) after a run.
