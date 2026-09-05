# Long-running job spike (chatticus-0edb18)

Feasibility probe: can a multi-day training run be a turn? Uses the existing
`computer_host_worker` pull path (`run_host_worker_once` / `main` loop) with
spike-only boot and action executors. No changes under `python/src`.

## Prerequisites

- AWS account `335163751677`, region `us-east-1`, `aws login`
- Python venv with `pip install -e ".[dev]"` from `python/`
- Env vars (see `env.example.sh`)

## Run

```bash
cd python
source ../spikes/long-running-job-0edb18/env.example.sh   # fill invoke key
python ../spikes/long-running-job-0edb18/run_spike.py --phase all
python ../spikes/long-running-job-0edb18/run_spike.py --phase authorized
```

Results land in `results/<run-id>/`.

## S3 prefix (throwaway)

`s3://chatticussnapshots-computersnapshotsb892d73f-r8qgykc9zjiq/spikes/0edb18/`

Objects are deleted after each run.
