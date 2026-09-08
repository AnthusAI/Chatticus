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

Published template: GET `https://dev.chattic.us/provisioning/customer-role.yml` then `create-stack --template-body` (later `update-stack` for policy holes). Never pass CloudFront as `--template-url`. First run: **6379 bytes**. After #314: **6705 bytes**; lab `UpdateStack` `ChatticusCrossAccountRole` `UPDATE_COMPLETE`. That closed the `8a25af` IGW-describe reopen. Snapshot bucket is **not** another `8a25af` role hole: it is `chatticus-bb9084` / #323, declared in the **customer-run** published template. Bucket name `chatticus-snapshots-${OrganizationId}`. The assumed role has **zero** `s3:`. Task-role `s3:GetObject`/`s3:PutObject` is on `ChatticusComputers` after `SnapshotBucketName` is passed. Lab stacks created before #323 still need **UpdateStack** (below).

## Person-steps (needed a human)

1. **Google sign-in** at `dev.chattic.us` and **create organization** (`POST /organizations`). Operator CLI must not `members seed` the throwaway org (seed writes `aws_account_id` from the STS caller).
2. **Copy `ORGANIZATION_ID` (`tenant_id`)** for CloudFormation `OrganizationId`. The 2026-09-07 run used `members list --status pending`. **Fixed on `develop`** (`chatticus-9c8dbf` / #325): welcome and enabled workspace show name, status, and tenant_id from `GET /me`.
3. **GET the published YAML** and `create-stack` in the **customer** account with `AnthusAccountId=ANTHUS_ACCOUNT_ID`, `OrganizationId=ORGANIZATION_ID`, `--capabilities CAPABILITY_NAMED_IAM`.
4. **Submit account id + RoleArn** in-product (`chatticus-070cb4` / #326). The 2026-09-07 run used a labeled operator kernel call.
5. **Create a bot.** Enabled workspace lists bots but has **no create-bot control**. This run used kernel `create_bot` → **Ping** (also `ensure_computer` Dynamo row).
6. **Send F-safe** from the UI: `Reply with exactly: pong.` Human confirmed the turn completed. Computerless; do not wait for a computer to boot.

### Lab-only person-steps (not the customer path)

- Organizations **management-account** email verification (24h link). Mail goes to the management mailbox, not the member alias. Required to *invite existing* accounts; this run used `CreateAccount`, which had already succeeded (~16s).
- Management **root** cannot `AssumeRole` (`Roles may not be assumed by root accounts`). Workaround: IAM user in the management account. A customer runs CloudFormation as root **in their own account** and does not hit this.
- Extra IAM `sts:AssumeRole` on `ChatticusOrganizationComputerRole` for that lab user (beyond `OrganizationAccountAccessRole`).

## Instruction defects (product)

- Welcome / holding page: no org name, status, or `tenant_id` — **fixed on `develop`** (`chatticus-9c8dbf` / #325).
- No HTTP to submit RoleArn after CFN — **fixed on `develop`** (`chatticus-070cb4` / #326). Pending owner `POST /orgs/{tenant_id}/self-setup/cross-account-role`. Live inspect is AssumeRole + inline `GetRolePolicy` (not `SimulatePrincipalPolicy`). 2026-09-08: ThinTurn+web deployed; new pending org + existing customer RoleArn returned **422** (ExternalId mismatch); unauthenticated **403**. Happy-path 200 is Gherkin; live 200 would need a second customer role stack whose OrganizationId matches that pending org — do not retarget the working throwaway role.
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

**Architecture cite (`4142832`):** the snapshot protocol is the **design target, not currently wired**. An earlier note called it "the shipping design" (`48a2c79`); that overstated it. Two file layers exist and are not connected. The snapshot library should not be deleted; it is unwired, not load-bearing.

**Open decision:** dict vs host disk is **decided host disk** (`chatticus-fccc4e9a-b3c6-4a14-9317-d0b0c95231b7`). Terminal is its own build: `chatticus-e11c17ed-195c-4ad5-8b06-49d2740d20d4`. `chatticus-bb908488-266d-4df9-9d15-355ff98ed0ac` is now required, not mere insurance.

**`chatticus-8fe4c7` confirming check (2026-09-07):** the IaC pull-auth hypothesis was **falsified**. Customer tasks pull the Anthus image (repository policy already grants the customer account). They reach RUNNING, then `computer_host_worker` exits 1: customer task role `AccessDenied` on Anthus Dynamo `GetItem`. Named cause `HOST_TASK_ROLE_DYNAMO_ACCESS_DENIED`. Zero `CannotPullContainerError`. Do not add `dynamodb:*` to the customer role. Wiki placeholders; desk ids in `AGENTS.local.md`.

**`chatticus-8fe4c7` closed (2026-09-07):** Front Door HTTP host (#319) plus Anthus `:dev` rebuild. Kernel `browser_open` / `about:blank` → journal `opened:about:blank`. Customer `RunTask` 1, Anthus 0. No Dynamo `AccessDenied` in the test window. Do not fold elapsed time into ~19 min.

**`chatticus-2b3c4173` (#320, on `develop`):** Customer `ChatticusComputers` declares ECR; task definition pulls `:dev` from `CUSTOMER_ACCOUNT_ID`. After ThinTurn deploy, an Anthus operator runs `computer/push-customer-computer-image.sh` (AssumeRole with `CHATTICUS_CUSTOMER_ROLE_ARN` + `CHATTICUS_ORGANIZATION_ID` from `AGENTS.local.md` — not Lambda, not ComputerWorker). Until that publish, host start refuses missing `:dev`. Do not fold elapsed time into ~19 min.

| # | Row | First-pass stop | After tool-list |
| --- | --- | --- | --- |
| 1 | Terminal | `REFUSED_NO_CUSTOMER_COMPUTERS_STACK` | **Not implemented** — own card `chatticus-e11c17ed-195c-4ad5-8b06-49d2740d20d4`. Do not live-run. |
| 2 | Browser | `REFUSED_NO_CUSTOMER_COMPUTERS_STACK` | **PASS (2026-09-07), kernel deviation.** `prepare_computer_tool(browser_open, about:blank)` + `enqueue_computer_continuation` (not computerless `browse`). Journal `tool.result` `opened:about:blank`. Customer `RunTask` 1, Anthus 0. `chatticus-8fe4c7e1` closed. Do not fold elapsed time into ~19 min. |
| 3 | File actions | `REFUSED_NO_CUSTOMER_SNAPSHOT_BUCKET` | **PASS (2026-09-08), kernel deviation.** Lab UpdateStack then write → publish → stop/start → read. Journal `write_workspace:/workspace/research/recycle-live.txt` then `read_workspace` body `persisted-by-agent-live-863f27`. Pack URI `s3://chatticus-snapshots-{ORGANIZATION_ID}/…`. Customer `RunTask`, Anthus 0. First attempt named cause `HOST_IMAGE_STALE_CHROMIUM_EXECUTOR_ONLY` — operator `push-customer-computer-image.sh` then retry. Do not fold elapsed time into ~19 min. |
| 4 | Approvals | `APPROVAL_NO_CROSS_ACCOUNT_PATH` | No agent tool. Kernel/human binding. Not a host sweep. |
| 5 | Spend ceiling | `SPEND_LIMIT_NOT_ENFORCED_AT_SINK` | Live model has no `purchase` tool. Token ledger is separate. Not a host sweep. |
| 6 | Relocate | `REFUSED_NO_CUSTOMER_SNAPSHOT_BUCKET` | In-process relocate/hydrate is in #324. Live **stop/start** recycle is proven in the 2026-09-08 file-actions row (host publish, hydrate, same bytes). Live relocate to a **different** worker was not a separate run. |

## Customer snapshot bucket — lab UpdateStack (after #323 / #324)

Gherkin on `develop` does not create the throwaway account's bucket. A lab IAM user (not management root) must refresh the customer-run stacks. Placeholders only; desk ids stay in `AGENTS.local.md`.

1. GET `https://dev.chattic.us/provisioning/customer-role.yml` (after development ThinTurn has published the #323 template).
2. Same principal: `update-stack` on the existing cross-account role stack with `--template-body` (never CloudFront as `--template-url`). Confirm output `OrganizationSnapshotBucket` is `chatticus-snapshots-ORGANIZATION_ID` (lowercase).
3. Same principal: `update-stack` `ChatticusComputers` with parameter `SnapshotBucketName` set to that output. Do not `cdk deploy --all`. Do not `CreateBucket` on an Anthus role.
4. Acceptance (not required to merge Gherkin): computerless write → host publish → stop/start or relocate → read the same bytes; journal `read_workspace` contains the written text.

**2026-09-08 live PASS:** Lab IAM user `chatticus-b88c0a-operator` (not management root) via `OrganizationAccountAccessRole` in `CUSTOMER_ACCOUNT_ID`. `ChatticusCrossAccountRole` and `ChatticusComputers` both `UPDATE_COMPLETE`. Output `OrganizationSnapshotBucket` / `SnapshotBucketName` = `chatticus-snapshots-{ORGANIZATION_ID}`. `head-bucket` succeeded; pack objects present. Kernel write/publish/stop/start/read as above. Earlier `AWS_LOGIN_SESSION_EXPIRED` was operator-only and is cleared.

## Not done on this run

| Step | Status |
| --- | --- |
| Consumer AWS signup | Skipped (lab `CreateAccount`) |
| Customer snapshot bucket **exists** in the throwaway account | **Done 2026-09-08** — UpdateStack #323 template; `head-bucket` on `chatticus-snapshots-{ORGANIZATION_ID}`. |
| Dict vs host disk | **Closed** — five steps on `develop` plus live write/publish/read (`4ac60c71` #318, `47533582` #321, `5ac06b` #322, `bb908488` #323, `863f27` #324). |
| Agent terminal tool (build, not a sweep) | `chatticus-e11c17ed-195c-4ad5-8b06-49d2740d20d4` |
| Remaining capability matrix | `chatticus-3e72dc16-ff6f-44f2-8d3c-dd3a49f9ac52` — parked; browser and file-actions host rows PASS; do not live-run terminal |
| Customer image in customer ECR | `chatticus-2b3c4173` / #320 **closed** — `:dev` published under the assumed role |

## Replay (customer-shaped, once the gaps close)

1. Customer owns `CUSTOMER_ACCOUNT_ID` (their org, their bill).
2. Sign in, create org, copy `ORGANIZATION_ID` from the product (not CLI).
3. GET published `customer-role.yml`; `create-stack --template-body` with `AnthusAccountId` and `OrganizationId`.
4. Submit RoleArn in-product (not kernel).
5. Create a bot in the workspace; send a computerless message.

Until steps 2, 4, and 5 exist in the product, an operator still has to stand in.
