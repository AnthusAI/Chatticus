# Throwaway account provisioning (timed hand run)

**Kanbus:** `chatticus-b88c0a` (2026-09-07). Development only (`dev.chattic.us`).

Desk AWS account ids, member-account ids, `tenant_id`s, RoleArns, and billing emails stay in gitignored `AGENTS.local.md`. This page uses placeholders (`ANTHUS_ACCOUNT_ID`, `CUSTOMER_ACCOUNT_ID`, `ORGANIZATION_ID`).

## What this number is

| Metric | Value |
| --- | --- |
| T0 | 2026-09-07T15:33:01Z |
| T_end (F-safe confirmed) | ~2026-09-07T15:52Z |
| **Wall-clock (Chatticus provision)** | **~19 minutes** |
| AWS-wait (instrumented) | ~48s (`CreateAccount` ~16s + role stack ~30s + misc ~2s) |
| Consumer aws.amazon.com signup (phone/card) | **Skipped — unmeasured** |

This run used AWS Organizations `CreateAccount` on the existing Anthus management account for **lab consolidated billing**. It is **not** the customer funnel. Real customers stay out of this org. Pitch page, invitation rate, and the $100 setup fee should use the **Chatticus-provision** number (~19 min here) and treat AWS account signup as a separate, still-unmeasured stopwatch.

Published template: GET `https://dev.chattic.us/provisioning/customer-role.yml` then `create-stack --template-body`. Never pass CloudFront as `--template-url`. This run: **6379 bytes, unmodified**, stack `ChatticusCrossAccountRole` `CREATE_COMPLETE`. That closed `chatticus-8a25af` until `82dab7` proved a policy hole (`ec2:DescribeInternetGateways`); the card is **reopened**.

## Person-steps (needed a human)

1. **Google sign-in** at `dev.chattic.us` and **create organization** (`POST /organizations`). Operator CLI must not `members seed` the throwaway org (seed writes `aws_account_id` from the STS caller).
2. **Copy `ORGANIZATION_ID` (`tenant_id`)** for CloudFormation `OrganizationId`. The pending welcome screen did not show name or id (`chatticus-9c8dbf`). This run used `members list --status pending`.
3. **GET the published YAML** and `create-stack` in the **customer** account with `AnthusAccountId=ANTHUS_ACCOUNT_ID`, `OrganizationId=ORGANIZATION_ID`, `--capabilities CAPABILITY_NAMED_IAM`.
4. **Submit account id + RoleArn** to the control plane. There is **no customer HTTP** for `submit_self_setup_cross_account_role`. This run used a labeled operator kernel call (not seed). Kernel submit **enables** the org and writes AWS home.
5. **Create a bot.** Enabled workspace lists bots but has **no create-bot control**. This run used kernel `create_bot` → **Ping** (also `ensure_computer` Dynamo row).
6. **Send F-safe** from the UI: `Reply with exactly: pong.` Human confirmed the turn completed. Computerless; do not wait for a computer to boot.

### Lab-only person-steps (not the customer path)

- Organizations **management-account** email verification (24h link). Mail goes to the management mailbox, not the member alias. Required to *invite existing* accounts; this run used `CreateAccount`, which had already succeeded (~16s).
- Management **root** cannot `AssumeRole` (`Roles may not be assumed by root accounts`). Workaround: IAM user in the management account. A customer runs CloudFormation as root **in their own account** and does not hit this.
- Extra IAM `sts:AssumeRole` on `ChatticusOrganizationComputerRole` for that lab user (beyond `OrganizationAccountAccessRole`).

## Instruction defects (product)

- Welcome / holding page: no org name, status, or `tenant_id` (`chatticus-9c8dbf`).
- No HTTP to submit RoleArn after CFN; no live `CrossAccountRoleInspector` (Gherkin in-memory only).
- No create-bot UI in the enabled workspace (`POST /bots` exists; UI never calls it).
- `infra/README.md` `create-stack` example omitted `--parameters` and `CAPABILITY_NAMED_IAM`.
- Published role CFN is scoped to `ChatticusComputers*` only — not `ChatticusSnapshots`. Snapshot bucket is **not** in the first customer `ChatticusComputers` template (`chatticus-8a25af` before file-actions).
- Workspace prompt did not escalate: Ping answered **no** (`STOP_NO_COMPUTER_TOOL`).
- `POST .../turns/{id}/resume` while the computer is stopped is `ComputerNotReadyError`; first summon needs kernel `enqueue_computer_continuation`.
- ComputerWorker nack omits provisioning exception text.

## F-computer (`chatticus-2f2d87`, closed 2026-09-07)

Attempted after F-safe. **Do not fold this elapsed time into the ~19 min figure.**

| Metric | Value |
| --- | --- |
| Path | Kernel deviation (standing rule): `post_channel_message` + `prepare_computer_tool` + `enqueue_computer_continuation`. UI path stopped at `STOP_NO_COMPUTER_TOOL`. |
| AssumeRole | **Yes** — ComputerWorker → `ChatticusOrganizationComputerRole` |
| `RunTask` in `ANTHUS_ACCOUNT_ID` | **No** (desiredCount stayed 0) |
| `RunTask` in `CUSTOMER_ACCOUNT_ID` | **No** — stack `ChatticusComputers` does not exist |
| Silent Anthus fallback | **No** |
| Kernel handoff elapsed | **~5.0 s** (2026-09-07T16:16:01Z → 16:16:06Z) |
| ComputerWorker nack | **~0.8 s** |
| Labeled stop | `REFUSED_NO_CUSTOMER_COMPUTERS_STACK` |

**Who creates `ChatticusComputers` in the customer account:** Chatticus, under the assumed role. Customer does not run a second template. This slice has **no snapshot bucket** (no `s3:*` on the published role). Bucket + scoped `s3:*` is `chatticus-8a25af` before `chatticus-3e72dc` file-actions. Anthus `ChatticusSnapshots` / `ChatticusComputers` stay Anthus-managed. Never destroy them. Never `cdk deploy --all`.

## Customer Computers (`chatticus-82dab7`, **reopened** 2026-09-07)

PR #312 on `develop` (`9826f2b`). First live attempt inferred CreateStack/RunTask from ComputerWorker because management **root** cannot AssumeRole into the member account.

**`chatticus-3e72dc` preflight (lab IAM user, same day):** `DescribeStacks(ChatticusComputers)` in `CUSTOMER_ACCOUNT_ID` → stack does not exist; customer ECS cluster list empty.

**Named cause 1 (fixed in #313, `fb0d7d5`):** `CREATESTACK_NEVER_SUCCEEDED_SSM_GETPARAMETERS_DENIED` — CDK `BootstrapVersion` SSM. Do **not** add `ssm:*` to the published role.

**Named cause 2 (live after #313, `chatticus-8a25af` reopened):** `CREATESTACK_ROLLBACK_EC2_DESCRIBE_INTERNET_GATEWAYS_DENIED`. Lab IAM user: one successful customer `CreateStack` API call; stack `ROLLBACK_FAILED` (IGW describe denied; rollback also failed). Customer `RunTask` **0**. Anthus `RunTask` **0**. `ensure_stack` currently refuses `ROLLBACK_FAILED` forever — recovery is product work on `82dab7` after the role lands.

## Capability matrix (`chatticus-3e72dc`, 2026-09-07)

Kernel path. **Do not fold elapsed times into the ~19 min figure.** None of six rows proven.

| # | Row | Stop |
| --- | --- | --- |
| 1 | Terminal | `REFUSED_NO_CUSTOMER_COMPUTERS_STACK` (~1.6 s) |
| 2 | Browser | `REFUSED_NO_CUSTOMER_COMPUTERS_STACK` (~1.7 s) |
| 3 | File actions | `REFUSED_NO_CUSTOMER_SNAPSHOT_BUCKET` (~127 s; `turn.waiting=workspace`) |
| 4 | Approvals | `APPROVAL_NO_CROSS_ACCOUNT_PATH` (no customer host) |
| 5 | Spend ceiling | `SPEND_LIMIT_NOT_ENFORCED_AT_SINK` (standing denial, not dollar ceiling) |
| 6 | Relocate | `REFUSED_NO_CUSTOMER_SNAPSHOT_BUCKET` |

## Not done on this run

| Step | Status |
| --- | --- |
| Consumer AWS signup | Skipped (lab `CreateAccount`) |
| Customer snapshot bucket / `s3:*` on published role | Not this slice — `chatticus-8a25af` before file-actions |
| Terminal / browser / files / approvals / spend / relocate | `chatticus-3e72dc` |

## Replay (customer-shaped, once the gaps close)

1. Customer owns `CUSTOMER_ACCOUNT_ID` (their org, their bill).
2. Sign in, create org, copy `ORGANIZATION_ID` from the product (not CLI).
3. GET published `customer-role.yml`; `create-stack --template-body` with `AnthusAccountId` and `OrganizationId`.
4. Submit RoleArn in-product (not kernel).
5. Create a bot in the workspace; send a computerless message.

Until steps 2, 4, and 5 exist in the product, an operator still has to stand in.
