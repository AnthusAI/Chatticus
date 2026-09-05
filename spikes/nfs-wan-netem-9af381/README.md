# NFS-over-WAN netem pre-experiment (chatticus-9af381 Phase A0)

Throwaway lab that answers whether the D5 threshold table is reachable at
home-link RTT **without AWS, EFS, tunnel, or CDK**.

Kanbus: `chatticus-9af381`. Phase A0 does **not** close the card.

## Question

Is metadata-heavy work on NFS over ~40 ms RTT viable when the attribute
cache (`actimeo`) is the mitigation?

## Decision thresholds (fixed before measurement)

Warm-cache NFS wall time divided by warm local-disk wall time. Verdict uses
**max** across these three operations only (pip install is diagnostic mixed
I/O and is excluded — see below).

| Warm-cache ratio vs local disk | Verdict |
| --- | --- |
| Within ~3x | D1-D5 hold for interactive host |
| 3-10x | Marginal; reopen org-on-EFS / local hot tree split |
| Over 10x | Local interactive host not viable |

`ratio_overall = max(ratio_git_status, ratio_checkout, ratio_stat_sweep)`.

## Operations

| Op | Command | In verdict? |
| --- | --- | --- |
| git status | `git status` | Yes |
| git checkout | `git checkout bench-a && git checkout bench-b` | Yes |
| stat sweep | `find . -type f -print0 \| xargs -0 stat` | Yes |
| pip install | `pip install --no-cache-dir -r requirements.txt -t /workspace/.pip-scratch` | No (dest on NFS mount; excluded from ratio) |

## actimeo sweep

| Label | Mount option |
| --- | --- |
| default | omit `actimeo` (kernel acreg/acdir defaults) |
| 1 | `actimeo=1` |
| 15 | `actimeo=15` |
| 60 | `actimeo=60` |
| 300 | `actimeo=300` |

## Lab topology

Linux containers on Docker (Darwin host). NFSv4.1 only.

```
nfs-server (kernel NFS or nfs-ganesha fallback)
    ^
    |  LAN (no delay on server side)
    |
client-a, client-b -- tc netem delay 20ms on eth0 (~40ms RTT)
local-control    -- bind mount, no NFS, no netem
```

- FS-Cache / `cachefilesd` is **off**; this spike isolates `actimeo`.
- Two clients (separate containers) for ea918a staleness — one client is not an answer.

## Limitations (by design)

- Not EFS latency floor, not stunnel, not WireGuard tunnel.
- Docker volume FS for local control may differ from bare metal.
- Userspace Ganesha if kernel `nfs-kernel-server` cannot export in container.

## Inversions to avoid

| Inversion | Guard |
| --- | --- |
| macOS nfsd | Linux containers only |
| One NFS client for staleness | client-a + client-b |
| Moving thresholds after data | Table above is frozen |
| Kanbus EFS `fs-09fcbd58a2e2d2c98` | Local NFS only |
| Cold cache for verdict | Warm runs only for ratio |
| pip to `/tmp` hiding NFS cost | pip dest on mount; excluded from ratio anyway |

## Run

```bash
cd spikes/nfs-wan-netem-9af381
./scripts/run-all.sh
```

Results land in `results/`. See `results/README.md` after a run.

## NFS server backend

Recorded in `results/lab-info.json` after seed (`server_backend`: `kernel` or `ganesha`).
