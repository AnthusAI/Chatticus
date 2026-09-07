# Results

Spike tag: **chatticus-3d5357**  
Throwaway EFS `fs-028e92bee71335473` in `vpc-0c5a0f0ca21e2afdd` / `subnet-06c4e78bf06400f26` (destroyed after run).

## Headline

**EFS in-VPC mutating `ratio_overall` is 23–54× vs local EBS on the same instance — D1 fails for `/workspace` (>10×).**  
Read-only warm `git status` stays ~10–12× EBS even with actimeo; RPC drops ~35% from first post-remount run but does not approach zero.  
`actimeo=1` shows cache thrashing on repeat status (RPC alternates 131/765). A0 WAN numbers are not used as in-VPC prediction.

## Tables

- [summary.md](summary.md)
- [readonly-actimeo.md](readonly-actimeo.md) — read-only `git status` loop vs EBS
- [mutating-actimeo.md](mutating-actimeo.md) — A0 mutating sequence vs EBS

Committed JSON: `raw/ebs-control.json`, `raw/efs-readonly-actimeo-*.json`, `raw/efs-mutating-actimeo-*.json`.
