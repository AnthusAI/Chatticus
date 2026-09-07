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

Published template: GET `https://dev.chattic.us/provisioning/customer-role.yml` then `create-stack --template-body`. Never pass CloudFront as `--template-url`. This run: **6379 bytes, unmodified**, stack `ChatticusCrossAccountRole` `CREATE_COMPLETE`. That closed `chatticus-8a25af`.

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
- Published role CFN is scoped to `ChatticusComputers*` only — not `ChatticusSnapshots`. ComputerWorker does **not** `CreateStack`. Dynamo computer row exists; ECS/ECR in `CUSTOMER_ACCOUNT_ID` does not (`chatticus-82dab7`).
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

**Who creates `ChatticusComputers` in the customer account:** Chatticus, under the assumed role (`chatticus-82dab7`). Customer does not run a second template. Snapshot bucket lives **inside** that customer `ChatticusComputers` stack; a customer stack named `ChatticusSnapshots` would be a template change (`chatticus-8a25af`). Anthus `ChatticusSnapshots` / `ChatticusComputers` stay Anthus-managed. Never destroy them. Never `cdk deploy --all`.

## Not done on this run

| Step | Status |
| --- | --- |
| Consumer AWS signup | Skipped (lab `CreateAccount`) |
| Customer `ChatticusComputers` / ECR `:dev` / snapshot bucket in customer account | Not deployed — Chatticus must `CreateStack` under the assumed role (`chatticus-82dab7`) |
| F-computer (cross-account RunTask) | Attempted; refused (missing customer stack). Zero `RunTask` in both accounts. |

## Replay (customer-shaped, once the gaps close)

1. Customer owns `CUSTOMER_ACCOUNT_ID` (their org, their bill).
2. Sign in, create org, copy `ORGANIZATION_ID` from the product (not CLI).
3. GET published `customer-role.yml`; `create-stack --template-body` with `AnthusAccountId` and `OrganizationId`.
4. Submit RoleArn in-product (not kernel).
5. Create a bot in the workspace; send a computerless message.

Until steps 2, 4, and 5 exist in the product, an operator still has to stand in.
