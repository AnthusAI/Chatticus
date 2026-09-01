# Computer cold-start measurement (Test 2)

Throwaway Fargate ARM64 timings for `docs/FEASIBILITY_TESTS.md` Test 2.
Not product code. The Computers **service desired count stayed 0**; each
run used `RunTask` and `StopTask`.

## Summoned browser gate (chatticus-d68966, 2026-08-31)

ECR image `.../chatticuscomputers-computerimage67d4263c-h3us7njdifay:dev`
(pushed 2026-08-31, digest `sha256:134b90af…`), task definition
`ChatticusComputersComputerTask96CD9924:5`, 0.25 vCPU / 512 MiB, ARM64.

Five sequential cold `RunTask`s with summon overrides:
`CHATTICUS_COMPUTER_BOOT=1` and a one-shot
`ComputerHostBootDriver().boot_through_browser()` command (image venv
`python` on `PATH`). No `CHATTICUS_SMOKE_COMPUTER`, no SQS, no DynamoDB.

| Gate | Proxy |
| --- | --- |
| Task submitted | `RunTask` returns |
| Process and network | ECS `lastStatus=RUNNING` |
| Browser profile hydrated, display and Chromium up | first CloudWatch `browser_gate_ready:` after `boot_through_browser()` |

### Fargate spread (five sequential summoned `RunTask`s)

Seconds from submit:

| Run | RUNNING | Browser gate |
| --- | --- | --- |
| 1 | 26.0 | 25.9 |
| 2 | 28.4 | 29.8 |
| 3 | 25.9 | 26.0 |
| 4 | 26.0 | 26.8 |
| 5 | 25.9 | 26.1 |

RUNNING min / median / max: **25.9 / 26.0 / 28.4 s**.
Browser gate min / median / max: **25.9 / 26.1 / 29.8 s**.

Browser gate is typically within ~1 s of RUNNING (Xvfb + Chromium probe on
the summoned path). Compared to the pre-Chromium e747d7 RUNNING baseline
(**17.7 / 22.0 / 38.5 s**), the median rose ~4 s with the larger Chromium
image; consecutive runs did not collapse to a much faster band (run 2 was
the slowest on browser gate).

Raw JSON: [fargate.json](fargate.json).

## Pre-Chromium smoke path (e747d7, 2026-08-31)

Earlier measurement used default container command (`sleep infinity`) with
`CHATTICUS_SMOKE_COMPUTER` snapshot pack. Chromium was not in the image.

| Gate | Proxy |
| --- | --- |
| Task submitted | `RunTask` returns |
| Process and network | ECS `lastStatus=RUNNING` |
| Python can reach AWS | smoke `manifest.json` in the snapshot bucket |
| Chromium ready | not in the image; incomplete |

RUNNING min / median / max: **17.7 / 22.0 / 38.5 s**.
Smoke manifest min / median / max: **20.1 / 22.2 / 40.8 s**.

No optimization was done during either measurement.
