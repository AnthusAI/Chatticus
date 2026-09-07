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

Published template: GET `https://dev.chattic.us/provisioning/customer-role.yml` then `create-stack --template-body` (later `update-stack` for policy holes). Never pass CloudFront as `--template-url`. First run: **6379 bytes**. After #314: **6705 bytes**; lab `UpdateStack` `ChatticusCrossAccountRole` `UPDATE_COMPLETE`. That closed the `8a25af` IGW-describe reopen. Snapshot bucket + scoped `s3:*` is **not** another `8a25af` role hole: it is `chatticus-bb9084`, declared in the **customer-run** published template (decision 2026-09-07). The assumed role has **zero** `s3:` today (`grep -c 's3:' infra/customer-role.yml` is 0).

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
- Published role CFN is scoped to `ChatticusComputers*` only. The snapshot bucket is **not** created by Chatticus inside `ChatticusComputers` under AssumeRole (that path AccessDenies: the role has no `s3:`). The bucket is declared in the customer-run published template (`chatticus-bb9084`).
- Workspace prompt exact reply: **I can't run shell commands directly in the household workspace.** Grants were **absent** on those turns (`create_bot` still assigns none — `chatticus-5336ff`). That sentence is **not** the sink string `no task grant`; one turn never called a tool, another called `request_computer_capability` then still that prose (`STOP_NO_COMPUTER_TOOL`). Do not tune prompts.
- `POST .../turns/{id}/resume` while the computer is stopped is `ComputerNotReadyError`; first summon needs kernel `enqueue_computer_continuation`.
- ComputerWorker nack logs `reason=` (#316). Host start passes a real `CHATTICUS_USER_ID` (#317). Customer `RunTask` proven (`chatticus-82dab7` closed).

## Refuse-not-fallback (production-verified, 2026-09-07)

Cite this section for any customer-facing claim. It is not only a card comment.

**Property:** If Chatticus can assume the customer computer role but the customer has no `ChatticusComputers` stack, the turn **refuses**. Chatticus must not start a computer in the Anthus account.

**Verified on development** with the throwaway customer account (`chatticus-2f2d87`, 2026-09-07). This was an in-memory Gherkin scenario first; the live run is the production result.

| Check | Result |
| --- | --- |
| AssumeRole of `ChatticusOrganizationComputerRole` in `CUSTOMER_ACCOUNT_ID` | **Succeeded** |
| Customer stack `ChatticusComputers` | **Absent** |
| `RunTask` in `CUSTOMER_ACCOUNT_ID` | **0** |
| `RunTask` in `ANTHUS_ACCOUNT_ID` | **0** |
| Anthus `ChatticusComputers` desiredCount | **0** |
| Labeled stop | `REFUSED_NO_CUSTOMER_COMPUTERS_STACK` |

Later customer-account `CreateStack` / `RunTask` (`chatticus-82dab7`) does not unwind this: Anthus desiredCount stays 0; there is still no Anthus fallback.

## F-computer (`chatticus-2f2d87`, closed 2026-09-07)

Attempted after F-safe. **Do not fold this elapsed time into the ~19 min figure.** The safety property for this attempt is [Refuse-not-fallback](#refuse-not-fallback-production-verified-2026-09-07).

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

**Who creates `ChatticusComputers` in the customer account:** Chatticus, under the assumed role. Do **not** ask the customer to run a second template for that stack. Do **not** put an `AWS::S3::Bucket` in it — `customer-role.yml` has zero `s3:`; CloudFormation creates resources with the caller's permissions, and `ChatticusComputers*` only names which stacks the role may touch. The snapshot bucket is declared in the **same published customer-run template** (`chatticus-bb9084`); after that, the assumed role needs only read/write on the named bucket, not `s3:CreateBucket`. Anthus `ChatticusSnapshots` serves Anthus-managed orgs only. Never destroy Anthus `ChatticusSnapshots` or `ChatticusComputers`. Never `cdk deploy --all`.

## Customer Computers (`chatticus-82dab7`, **closed** 2026-09-07)

Chatticus CreateStacks `ChatticusComputers` in the customer account under the assumed role. `:dev` image pullable. **Customer-account `RunTask ≥ 1`** proven (lab IAM user, not root, not `dispatch_ok`). Anthus `RunTask` 0; desiredCount 0.

PR #317 (`7d6dc1a`) — continuation host-start passes the turn prompt author into `CHATTICUS_USER_ID`. ThinTurn development deploy https://github.com/AnthusAI/Chatticus/actions/runs/34160413819 succeeded. Kernel summon 2026-09-07T20:47:39Z → customer CloudTrail `RunTask` at 20:47:42Z. **Do not fold this elapsed time into the ~19 min figure.**

**Named cause 1 (fixed in #313, `fb0d7d5`):** `CREATESTACK_NEVER_SUCCEEDED_SSM_GETPARAMETERS_DENIED` — CDK `BootstrapVersion` SSM. Do **not** add `ssm:*` to the published role.

**Named cause 2 (fixed in #314 + lab UpdateStack; `8a25af` closed):** `CREATESTACK_ROLLBACK_EC2_DESCRIBE_INTERNET_GATEWAYS_DENIED`.

**Named cause 3 (fixed in #316, `6457a30`):** `LOOKUP_EMPTY_SUBNETS_DESCRIBE_SERVICES` / `HOST_START_NO_RUNTASK_AFTER_CREATE_COMPLETE`. Subnet/SG outputs + UpdateStack. Nack logs include `reason=`.

**Named cause 4 (fixed in #317, `7d6dc1a`):** `RUNTASK_USER_ID_NONE`. `ecs.run_task` no longer receives `CHATTICUS_USER_ID=None`.

## Capability matrix (`chatticus-3e72dc`, 2026-09-07)

Kernel path. **Do not fold elapsed times into the ~19 min figure.**

**First pass (before customer `RunTask`):** every computer-touching row stopped on missing stack or missing bucket — those stops are historical.

**Tool-list read (after `82dab7`, before more live rows):** `docs/ARCHITECTURE.md` already says the image shell is unreachable by an agent. Live `ls /workspace` with a **running** computer returned that answer. Host executor tools: `browser_open`, `request_computer_capability` (Chromium, browser gate only). Live OpenAI tools: task, `read_workspace`, `browse` (origin authorize), `request_computer_capability`. `read_workspace` / `write_workspace` operate on `computer.workspace` (in-process dict). Dynamo does not persist it. Nothing in the agent loop reads the container's `/workspace`. `ComputerHostDisk` packs host directories to S3 in tests/CLI; the Fargate host worker does not publish or hydrate.

| # | Row | First-pass stop | After tool-list |
| --- | --- | --- | --- |
| 1 | Terminal | `REFUSED_NO_CUSTOMER_COMPUTERS_STACK` | **Not implemented** — no agent tool. Do not live-run again. |
| 2 | Browser | `REFUSED_NO_CUSTOMER_COMPUTERS_STACK` | **`browser_open` is real** — only row worth a computer-host live test. Computerless `browse` does not open Chromium. |
| 3 | File actions | `REFUSED_NO_CUSTOMER_SNAPSHOT_BUCKET` | **Not a host-disk path.** `read_workspace` hits the dict, not `/workspace`, and not the snapshot bucket. Same shape as terminal (name ≠ tool). `bb9084` is still the bucket for **host packs**, which agents do not write today. |
| 4 | Approvals | `APPROVAL_NO_CROSS_ACCOUNT_PATH` | No agent tool. Kernel/human binding. |
| 5 | Spend ceiling | `SPEND_LIMIT_NOT_ENFORCED_AT_SINK` | Live model has no `purchase` tool. Token ledger is separate. |
| 6 | Relocate | `REFUSED_NO_CUSTOMER_SNAPSHOT_BUCKET` | No agent tool. Host worker never publish/hydrate. |

## Not done on this run

| Step | Status |
| --- | --- |
| Consumer AWS signup | Skipped (lab `CreateAccount`) |
| Customer snapshot bucket in the published template | `chatticus-bb9084` (not inside `ChatticusComputers` under AssumeRole) |
| Terminal / browser / files / approvals / spend / relocate | `chatticus-3e72dc` |

## Replay (customer-shaped, once the gaps close)

1. Customer owns `CUSTOMER_ACCOUNT_ID` (their org, their bill).
2. Sign in, create org, copy `ORGANIZATION_ID` from the product (not CLI).
3. GET published `customer-role.yml`; `create-stack --template-body` with `AnthusAccountId` and `OrganizationId`.
4. Submit RoleArn in-product (not kernel).
5. Create a bot in the workspace; send a computerless message.

Until steps 2, 4, and 5 exist in the product, an operator still has to stand in.
