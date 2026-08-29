# Python control plane

The product brain. v1 encodes the worker protocol, roster, and approvals
here as an in-memory kernel. FastAPI, SQS adapters, and the agent loop
plug into this package.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
behave
```

Gherkin lives in `../features/`. Step definitions live in `../features/steps/`.
