# Computer cold-start measurement (Test 2)

Throwaway Fargate ARM64 timings for `docs/FEASIBILITY_TESTS.md` Test 2.
Not product code. The Computers **service desired count stayed 0**; each
run used `RunTask` and `StopTask`.

## What was measured

Existing ECR image `.../chatticuscomputers-computerimage67d4263c-h3us7njdifay:dev`
(pushed 2026-08-30, ~177 MiB), task definition
`ChatticusComputersComputerTask96CD9924:5`, 0.25 vCPU / 512 MiB, ARM64.

Gates:

| Gate | Proxy |
| --- | --- |
| Task submitted | `RunTask` returns |
| Process and network | ECS `lastStatus=RUNNING` |
| Python can reach AWS (`/workspace` written, snapshot packed) | smoke `manifest.json` in the snapshot bucket |
| Chromium ready | **not in the image**; incomplete |

Local Docker comparison: **not run**. The Docker CLI is present; the
daemon socket is not (`docker.raw.sock`).

## Fargate spread (five sequential `RunTask`s)

Seconds from submit:

| Run | RUNNING | Smoke manifest | First CloudWatch log |
| --- | --- | --- | --- |
| 1 | 20.0 | 20.2 | 20.0 |
| 2 | 22.0 | 22.2 | 22.2 |
| 3 | 38.5 | 40.8 | 39.4 |
| 4 | 17.7 | 20.1 | 19.1 |
| 5 | 24.1 | 26.4 | 24.5 |

RUNNING min / median / max: **17.7 / 22.0 / 38.5 s**.
Smoke manifest min / median / max: **20.1 / 22.2 / 40.8 s**.

Later runs were not uniformly faster than the first. Consecutive tasks
did not show a simple image-cache collapse; run 3 was the slowest.
The image was already in ECR, so this is host pull + task start, not
an image build.

Raw JSON: [fargate.json](fargate.json).

## How to read it

Time to “process can run Python and talk to AWS” is **tens of seconds**,
which is the band requirement 16 actually depends on. Browser-ready
bands in the feasibility test **do not apply yet**: Chromium is listed
as next on `computer/README.md` and is not in `computer/Dockerfile`.
Xvfb is installed; no display/browser startup was timed.

No optimization was done during the measurement.
