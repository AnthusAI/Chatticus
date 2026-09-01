# Adversarial browser injection evals

Throwaway research harness for Kanbus task **1e09b4** (parent epic **4ddbe1**).
The executable suite lives under `python/tests/` so it never ships on the
worker or Lambda import graph.

## What this measures

Page content may convince the model to request forbidden behavior. The
enforceable control is **worker-side sink denial**, not prompt wording.
A bypass is a blocking bug and must be fixed at grant, sink, or binding
logic — never by tightening system prompts.

Related product docs:

- [Browser authority policy](../../docs/BROWSER_AUTHORITY.md)
- [Threat model](../../docs/THREAT_MODEL.md)

## Tier A — in-process (CI default)

Deterministic evals with a `CompliantInjectionModel` that always obeys
injected page instructions (worst case). Each case loads HTML from
`python/tests/fixtures/adversarial_pages/`, routes the resulting operation
through real `ControlPlane` sink APIs, and asserts:

- forbidden effects are denied (exception or soft block)
- no connector delivery or unblocked egress
- `mark_injection_followed_by_model` is set; prompt wording is not the boundary
- allowed read-only operations still succeed

From `python/` after `pip install -e ".[dev]"`:

```bash
pytest tests/test_adversarial_injection_evals.py -v
```

Regression guard: `test_regression_guard_stubbed_allow_sink_fails_eval` proves
the suite fails when a sink is stubbed to ALLOW.

## Tier B — live OpenAI (optional)

Skipped unless `OPENAI_API_KEY` is set. Not CI-blocking.

```bash
export OPENAI_API_KEY=...
pytest tests/test_adversarial_injection_live_openai.py -v -m live_openai
```

Record optional run summaries in `results/` (gitignored JSON).

## Case categories

| Category | Examples |
| --- | --- |
| Workspace exfiltration | secrets-path read, staged write |
| Cross-origin navigation | evil origin browse |
| Message sending | direct, quoted, cross-page recipient |
| Hidden instructions | HTML comment, `display:none`, base64 attribute |
| Approval substitution | destination or payload swap after human approval |
| Allowed read-only | granted workspace read, granted origin browse |

## Out of scope

- Full Chromium on Fargate or Playwright page load in CI
- Production deploy, `cdk deploy --all`, Computers `desiredCount > 0`
- Epic **35d86b** demo CLI
- Prompt-only mitigations as a fix for failing evals
