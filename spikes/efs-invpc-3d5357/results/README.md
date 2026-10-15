# Results

Spike tag: **chatticus-3d5357**  
Throwaway EFS in `vpc-0c5a0f0ca21e2afdd` / `subnet-06c4e78bf06400f26` (destroyed after run). See `lab-info.json` for instance and seed metadata.

## Headline

**EFS in-VPC mutating `ratio_overall` is 23–54× vs local EBS — D1 fails for `/workspace` (>10×).**  
Read-only warm `git status` is ~10× EBS for actimeo ≥15/default/60/300 (RPC ~131 after first post-remount). **`actimeo=1` thrashes:** warm median ~0.27s and ~480 RPC (131/765 alternation). A0 WAN numbers are not used as in-VPC prediction.

Summaries in `raw/efs-readonly-actimeo-*.json` can be recomputed from `iterations_detail` via `./scripts/regen-readonly-summaries.sh` (no lab re-run).

## Tables

- [summary.md](summary.md)
- [readonly-actimeo.md](readonly-actimeo.md) — read-only `git status` loop vs EBS
- [mutating-actimeo.md](mutating-actimeo.md) — A0 mutating sequence vs EBS

Committed JSON: `raw/ebs-control.json`, `raw/efs-readonly-actimeo-*.json`, `raw/efs-mutating-actimeo-*.json`.
