# Computer cold-start spike

Throwaway measurement for feasibility Test 2. See
[results/README.md](results/README.md).

Summoned browser gate (chatticus-d68966): five sequential `RunTask`s with
`CHATTICUS_COMPUTER_BOOT=1` and a one-shot
`ComputerHostBootDriver().boot_through_browser()` command. Chromium-ready is
the first CloudWatch `browser_gate_ready:` line.

```bash
pip install boto3
python spikes/computer-cold-start/measure_fargate.py
```
