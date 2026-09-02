# Pytest → Gherkin migration survey

Working note for `cursor/behavior-specs-from-pytest`. Source of truth for
behavior is `features/*.feature`. Pytest stays for unit/helpers/structural
guards. This is a snapshot of `origin/develop` at survey time (~54 `test_*.py`
files). Many files already have a Gherkin twin; leftover pytest is still a
second source of truth and should be deleted after behave is green.

## First 15 MOVE candidates

Ordered by how clearly they describe user-observable behavior (HTTP status,
route guards, membership, grants). Prefer new Gherkin over deleting leftovers.

| # | Pytest file | Why MOVE | Target feature | Notes |
|---|-------------|----------|----------------|-------|
| 1 | `test_thin_grant_http.py` | PUT grant + gated workspace read HTTP 403/200 | `features/thin_grant_http.feature` (new) | No Gherkin yet. 3 HTTP tests. |
| 2 | `test_org_access.py` | Enabled member allowed; non-member denied; worker tenant match | `features/org_access.feature` (new) | Membership branching; no Gherkin yet. |
| 3 | `test_me_http.py` | GET `/me` fail-closed, empty/pending/enabled membership | `features/me.feature` (extend) | Feature exists; pytest leftover. Missing: 503 without verifier. |
| 4 | `test_org_path_routing.py` | `X-Tenant-Id` rejected; health outside org path | `features/org_path_routing.feature` | HTTP cases already in Gherkin. Keep `org_path()` helper unit test. |
| 5 | `test_worker_auth.py` | Worker bearer used on claim route | `features/worker_credentials.feature` (extend) | 1 HTTP test; feature already covers nearby auth. |
| 6 | `test_turn_capability_grant.py` | Grant persists across recycle; HTTP grant+read on durable store | `features/turn_capability_grant.feature` (new) | Mix of plane + HTTP durability. |
| 7 | `test_cognito_principal.py` | Token → principal; expired/unknown/suspended | `features/cognito_principal.feature` (extend) | Feature exists. Likely missing: non-member email, email-keyed identity (not `sub`). |
| 8 | `test_worker_credentials.py` | Worker route bearer, invoke-key reject, audience | `features/worker_credentials.feature` | Feature exists. Keep `hash_worker_token` unit test. |
| 9 | `test_thin_task_http.py` | HTTP task create/list/get tenant isolation | `features/thin_task_http.feature` | Feature exists. Keep OpenAI tool-call parser unit tests. |
| 10 | `test_principal.py` | Waitlist-safe marker; `/me`/`/health`/`/auth` policy | `features/principal.feature` | Feature exists. Keep Principal dataclass shape tests. |
| 11 | `test_capability_sinks.py` | Grant deny/allow at file/send sinks | `features/capability_sink_wiring.feature` | Feature exists; leftover pytest. |
| 12 | `test_approval_binding.py` | Exact destination/payload binding | `features/exact_consequential_approval.feature` / `approvals.feature` | Feature exists; leftover pytest. |
| 13 | `test_overnight_gated.py` | Unattended consequential blocks without exact preauth | `features/overnight_gated_action.feature` | Feature exists; leftover pytest. |
| 14 | `test_unbound_browser_action.py` | Unbound browser consequential actions stop | `features/unsupported_browser_action.feature` | Feature exists; leftover pytest. |
| 15 | `test_mid_turn_escalation.py` | First computer tool continues the same turn | `features/mid_turn_computer_escalation.feature` | Feature exists; leftover pytest. |

## KEEP (pytest)

| File | Why KEEP |
|------|----------|
| `test_cloud_environments.py` | Structural/coverage guard (account-origin scan). |
| `test_thinturn_deploy_script.py` | CDK/deploy script shape, not product behavior. |
| `test_chatticus_budgets.py` | Deploy-script/CDK context guards. |
| `test_computer_image.py` | Dockerfile/image layout. |
| `test_cognito_jwt.py` | JWT parser/crypto helper. |
| `test_openai_completion.py` | Chat-completion parser / prompt string. |
| `test_s3_store.py` | Object-store roundtrip helper. |
| `test_runtime.py` | SQS payload helper. |
| `test_browser_profiles.py` | Path mapping for Chromium profiles. |
| `test_tooling_auth.py` | Static scan (no `X-Tenant-Id` in live tooling). |
| `test_live_aws_thin_turn.py` | Live AWS skip-unless-flagged. |
| `test_adversarial_injection_evals.py` | Eval harness. |
| `test_adversarial_injection_live_openai.py` | Live model eval. |
| `test_turn_deadline_scheduler.py` | Scheduler name/format helpers + EventBridge client. |
| `test_worker_lambda_handler.py` | Lambda handler internals (review if nack becomes a Gherkin worker story). |

## REVIEW (later; mixed or already largely specified)

| File | Why REVIEW |
|------|------------|
| `test_messaging.py` | ~80 tests; `messages.feature` + `realtime_api.feature` cover much HTTP/SSE. Migrate remaining HTTP leftovers in slices, keep store-cursor helpers. |
| `test_org_records.py` | `organizations.feature` covers lifecycle. Keep email-normalization unit tests. |
| `test_org_seed.py` | `first_org_seed.feature` + `members_cli.feature` overlap. |
| `test_members_cli.py` | Feature exists; leftover CLI cases. |
| `test_control_plane.py` | Mix of org/computer/job routing already in features + error-path units. |
| `test_computer_worker.py` | `computer_continuation_worker.feature` overlap; worker dispatch leftovers. |
| `test_computer_start.py` | `single_computer_start.feature` overlap. |
| `test_computer_host_worker.py` / `test_computer_host_boot.py` / `test_host_starter.py` | Host-start features exist. |
| `test_exercise_thin_turn.py` | Mix of route-presence flags and string helpers. |
| `test_thin_turn_conversation.py` | Header/SSE parse helpers + org-scoped path usage. |
| `test_turn_recovery.py` / `test_turn_fault_injection.py` / `test_structured_handoff.py` | Matching features exist. |
| `test_thin_task_item.py` / `test_vendor_ledger.py` / `test_snapshot_pack.py` | Matching features exist. |
| `test_model_tool_loop_sinks.py` / `test_capability_policy.py` | Matching features exist. |
| `test_chromium_action_executor.py` | `chromium_host_executor.feature` overlap. |

## Process

Migrate **one pytest file at a time**. After behave is green, delete the
migrated pytest cases (keep genuine unit leftovers in the same file). Commit
`refactor(tests): move <test_X> behavior to <feature>.feature`.
