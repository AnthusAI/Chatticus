# Computer browser profile image pin (chatticus-914eb7)

Development ECR `:dev` image with partitioned Chromium profiles (`browser-profiles/untrusted` and `browser-profiles/privileged`) from host code chatticus-120f6e.

Pushed via `computer/push-computer-image.sh` (linux/arm64). ChatticusComputers **desiredCount stayed 0**; no CDK deploy.

ECR image `.../chatticuscomputers-computerimage67d4263c-h3us7njdifay:dev` (digest `sha256:823b4ac0…`), task definition `ChatticusComputersComputerTask96CD9924:5`.

One summoned `RunTask` smoke: `ComputerHostBootDriver().boot_through_browser()` then a live Chromium process with `--user-data-dir` under `browser-profiles/untrusted` (verified via `pgrep -a chromium`). Task stopped immediately; zero leftover RUNNING tasks.

Raw JSON: [dev-image.json](dev-image.json).
