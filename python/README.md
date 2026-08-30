# Python control plane

The product brain. v1 encodes the worker protocol, roster, approvals,
message store, and realtime API fan-out here as an in-memory kernel.
FastAPI, SQS adapters, and the agent loop plug into this package.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
behave
pytest
```

Gherkin lives in `../features/`. Step definitions live in `../features/steps/`.

Pack a host disk into the local snapshot store, or the CDK S3 bucket:

```bash
python -m chatticus.snapshot pack \
  --live-root ./var/hosts/fargate \
  --store ./var/snapshot-store \
  --tenant anthus \
  --computer household-computer \
  --worker fargate-1
```

`--store s3` uses `CHATTICUS_SNAPSHOT_BUCKET` from `npx cdk deploy` in `infra/`.
AWS login credentials need `botocore[crt]` (included in `pip install -e ".[aws]"`).
