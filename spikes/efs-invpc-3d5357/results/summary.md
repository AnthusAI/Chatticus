# chatticus-3d5357 EFS in-VPC results

EFS in-VPC (default actimeo) mutating ratio_overall=38.42x vs EBS — D1 fails for /workspace (>10x). A0 WAN numbers are not used as in-VPC prediction.
EBS checkout median 0.0146s is above timer resolution; `ratio_overall` includes checkout when it exceeds git_status and stat_sweep.

EFS: `fs-028e92bee71335473` in `vpc-0c5a0f0ca21e2afdd` / `subnet-06c4e78bf06400f26`
Seed files: 1015

See [readonly-actimeo.md](readonly-actimeo.md) and [mutating-actimeo.md](mutating-actimeo.md).

