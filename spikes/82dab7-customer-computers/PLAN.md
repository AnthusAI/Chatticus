# Plan: chatticus-82dab7 — Chatticus deploys ChatticusComputers in the customer account

**Kanbus:** `chatticus-82dab7` (Phase 1 of 5)  
**Parent epic:** `chatticus-598be488-151d-4e57-8897-5cf6aaed50e5`  
**Blocked-by:** nothing (`chatticus-2f2d87` closed with labeled refuse)  
**Unblocks:** `chatticus-3e72dc` (after customer snapshot bucket lands on `8a25af`)  
**Worktree:** `/tmp/chatticus-82dab7-customer-computers`  
**Branch:** `feat/customer-computers-stack-82dab7` (tracks `origin/develop`)  
**Status:** Plan revised after manager review — **do not implement until re-authorized**

---

## Goal

After F-computer (`chatticus-2f2d87`), ComputerWorker **assumes** `ChatticusOrganizationComputerRole` in `CUSTOMER_ACCOUNT_ID` but `DescribeStacks(ChatticusComputers)` fails because that stack does not exist. Zero `RunTask` in both accounts; Anthus `ChatticusComputers` desiredCount stayed 0. Refuse-not-fallback held.

**Done when (this slice only):** `ChatticusComputers` exists in `CUSTOMER_ACCOUNT_ID` because Chatticus created it under the assumed role; one computer-requiring turn reaches **customer-account `RunTask`**; Anthus `RunTask` count stays 0 and Anthus desiredCount stays 0.

**Explicitly not in this slice:** customer snapshot bucket, hydrate/publish, customer ECR replica, file actions (`chatticus-3e72dc`). Ephemeral container live root is enough to prove `RunTask`.

---

## Manager review — closed holes (do not rediscover)

| Rejected approach | Why | Correct path |
| --- | --- | --- |
| S3 snapshot bucket inside `CustomerComputersStack` | Published `customer-role.yml` has **no `s3:*`**. Bucket resource → `CREATE_FAILED`. Not a live-discovery item. | **Omit bucket entirely** from customer template. No `SnapshotBucketName` output. No `CHATTICUS_SNAPSHOT_BUCKET` on the task. Customer bucket + scoped `s3:*` on `customer-role.yml` is **`chatticus-8a25af` follow-up before `3e72dc`**. |
| ECR layer copy through ComputerWorker Lambda | 60s timeout; wrong shape. Customer ECR replica is out of scope. | Customer task definition **image = Anthus `ChatticusComputers` ECR `:dev` URI**. Anthus ECR **repository policy** grants the customer account execution role pull. Anthus-side CDK change; **not customer-visible**. |
| `auto-provision disabled` env flag in production Lambda | Dual code path in prod. | Gherkin refusal scenario uses a **test double** that cannot `CreateStack` — no env var in Lambda. |
| “Watch for S3 policy hole live” | Would waste a CreateStack attempt. | Decision is **pre-made**: no bucket in this template. |
| Inventing image bootstrap if Anthus `:dev` missing | Ops gap, not product gap. | Live preflight: Anthus `:dev` must exist (`computer/push-computer-image.sh`). If not, **stop** as Anthus ops — do not build a copy path. |

---

## What already happened (do not rediscover)

| Signal | F-computer result |
| --- | --- |
| AssumeRole (ComputerWorker → customer role) | **Yes** (CloudTrail) |
| `RunTask` in `ANTHUS_ACCOUNT_ID` | **No** (desiredCount 0) |
| `RunTask` in `CUSTOMER_ACCOUNT_ID` | **No** (no stack/cluster) |
| Silent Anthus fallback | **No** |
| Inferred stop | `DescribeStacks(ChatticusComputers)` ClientError — stack missing |
| Error mapping gap | ClientError not → `OrganizationComputerProvisioningError`; nack omits body |
| Kernel handoff | ~5 s; ComputerWorker nack ~0.8 s (not part of ~19 min provision figure) |

**Who creates what (this slice):**

| Asset | Who | How |
| --- | --- | --- |
| Cross-account IAM role | Customer | Published `customer-role.yml` (**unmodified** on this card) |
| `ChatticusComputers` (VPC, cluster, task def, logs, execution + task roles) | Chatticus under assumed role | `CreateStack` — already allowed on `stack/ChatticusComputers*/*` |
| Container image `:dev` | Anthus ops (pre-existing) | `computer/push-computer-image.sh` into **Anthus** `ChatticusComputers` ECR |
| Cross-account image pull at `RunTask` | ECS in customer account | Task def references Anthus ECR URI; Anthus repo policy grants customer execution role |
| Customer snapshot bucket | **Not this card** | `chatticus-8a25af` before `chatticus-3e72dc` |

Customer does **not** run a second template. Do **not** `cdk deploy` Anthus `ChatticusComputers` into the customer account.

---

## 1. Control-plane / worker path

### What runs today

```
SQS computer queue
  → ThinTurn ComputerWorker Lambda (python, 60s timeout; development CHATTICUS_HOST_STARTER=ecs)
    → ComputerWorker.run_job
      → _dispatch_host_start_if_needed
        → OrganizationComputerHostStarter.start_host(claim)
          → attempt_cross_account_assume_role (customer org)
          → lookup_customer_computer_ecs_config  # DescribeStacks + DescribeServices only
          → run_fargate_task  # never reached when stack missing
```

Relevant code: `python/src/chatticus/worker/computer.py`, `organization_computer_host.py`, `host_starter.py`, `infra/lib/computer-host-start.ts`.

### What must be added — lazy one-shot provision (accepted)

**Inversion to reject:** a new Lambda that `CreateStack`s on every host-start, or a kernel HTTP route per turn.

**Correct model:** idempotent **lazy provision** inside `OrganizationComputerHostStarter._start_in_customer_account`, invoked only when a computer-requiring turn triggers host start. First customer host start may take multiple SQS retries; later host starts are **Describe + RunTask** only.

```
OrganizationComputerHostStarter._start_in_customer_account
  1. AssumeRole (unchanged)
  2. ensure_customer_computers_stack(session, org)   # NEW
  3. lookup_customer_computer_ecs_config (unchanged)
  4. run_fargate_task in customer account (unchanged)
```

**Provision phases** (raise `OrganizationComputerProvisioningError` → ComputerWorker nacks → SQS retries; no blocking waiter for `CREATE_COMPLETE` inside one Lambda invocation):

| Phase | Action | Credentials | On incomplete |
| --- | --- | --- | --- |
| A | `DescribeStacks(ChatticusComputers)` | Customer session | Missing → B; `CREATE_IN_PROGRESS` → nack "provisioning in progress" |
| B | `CreateStack` (see §2 for body/URL, capabilities) + `TenantId` / image URI parameters | Customer session | Return immediately; nack "stack create started" |
| C | `DescribeStacks` until `CREATE_COMPLETE` or terminal failure | Customer session | In progress → nack; `CREATE_FAILED` → refuse with stack events |
| D | `lookup_customer_computer_ecs_config` + `RunTask` | Customer session | Existing path |

**CreateStack call must include:**

```python
Capabilities=["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"]
```

The template creates IAM roles (`ComputerTaskRole`, execution role). Both capabilities are required.

**Concurrency:** two host starts may race on `CreateStack`. "Already exists" → treat as success, poll. Stack name: `ChatticusComputers` exactly (`COMPUTERS_STACK_NAME`).

**Anthus same-account path unchanged:** `aws_account_id == deployment_account_id` → deployment ECS env vars only; no `CreateStack`, no AssumeRole.

**No new control-plane HTTP surface.** Infrastructure materializes on first host start.

### Lambda / IAM (Anthus side)

ComputerWorker Lambda already has `sts:AssumeRole` on `arn:aws:iam::*:role/ChatticusOrganizationComputerRole`. `CreateStack` runs under the **assumed customer session**, not the Lambda execution role.

**New Anthus-side change (not customer-visible):** ECR repository policy on Anthus `ChatticusComputers` repository granting `ecr:BatchGetImage` / `ecr:GetDownloadUrlForLayer` to the customer account's `ChatticusComputers*` execution role (or account principal scoped to that role pattern). Without this, customer `RunTask` fails at image pull — fix is Anthus CDK on the existing repo, not `customer-role.yml`.

ComputerWorker Lambda does **not** copy image layers. No new ECR permissions on the Lambda for copy.

---

## 2. Customer `ChatticusComputers` template production

### Hard constraints

| Constraint | Implication |
| --- | --- |
| `customer-role.yml` unchanged | No S3 bucket resource. No `s3:*` needed or granted. |
| CFN scope `ChatticusComputers*` | Stack name `ChatticusComputers`. No separate `ChatticusSnapshots` stack in customer account. |
| `TemplateBody` limit 51,200 bytes | Measure after synth (§2.1). |
| No Anthus `cdk deploy` into customer account | Synth → committed artifact → `CreateStack` under assumed role. |

### 2.1 Template size gate

After `cdk synth`:

1. Measure serialized template byte length.
2. **≤ 51,200 bytes:** pass `TemplateBody=` to `CreateStack` (same pattern as customers GET `customer-role.yml` then `--template-body` — CloudFormation cannot fetch CloudFront).
3. **> 51,200 bytes:** pass `TemplateURL=` pointing to an **Anthus S3 object URL** for the template object. CloudFormation fetches S3 directly; do not use CloudFront as `TemplateURL`.
4. **CI:** synth step fails if output drifts from the committed artifact (`customer-computers.template.json` or `.yaml`). No silent drift.

### 2.2 Stack contents (this slice)

**Include:**

- VPC (public subnets, no NAT — match Anthus `ComputerStack`)
- ECS cluster
- Fargate task definition with container image = **Anthus ECR `:dev` URI** (parameter `AnthusComputerImageUri` or built from `AnthusAccountId` + region + repo name at `CreateStack` time)
- Fargate service, `desiredCount: 0`
- CloudWatch log group
- `ComputerTaskRole` — **no S3 grants** (no bucket exists)
- Task execution role — ECR pull from Anthus cross-account
- Security group (egress only)

**Exclude (not this slice):**

- S3 snapshot bucket, `SnapshotBucketName` output, `CHATTICUS_SNAPSHOT_BUCKET` env on container
- Customer ECR repository and `PutImage` bootstrap
- `LocalWorkerRole` (Anthus-only garage-Mac pattern)

**Container environment (customer template):**

- `CHATTICUS_TENANT_ID` = `TenantId` parameter
- `CHATTICUS_LIVE_ROOT` = `/var/lib/chatticus/computer` (ephemeral; no hydrate)
- Do **not** set `CHATTICUS_SNAPSHOT_BUCKET`

### 2.3 CDK layout

| Piece | Purpose |
| --- | --- |
| `infra/lib/customer-computers-stack.ts` | `CustomerComputersStack` — computer host without snapshot bucket, image from Anthus ECR parameter |
| `infra/bin/customer-computers.ts` | Synth-only app entry; **no deploy target** in Anthus account |
| `python/src/chatticus/assets/customer-computers.template.json` | Committed synth output |

Refactor minimally: extract shared Fargate wiring from `ComputerStack` into a construct both stacks use. Anthus `ComputerStack` keeps `snapshotBucket` from separate `ChatticusSnapshots`; customer stack does not.

### 2.4 Parameters and outputs

**Parameters:**

| Name | Source at CreateStack |
| --- | --- |
| `TenantId` | `organization.tenant_id` |
| `AnthusComputerImageUri` | Deployment config: Anthus `ChatticusComputers` ECR `:dev` URI (from env/SSM in ComputerWorker, not customer input) |

**Required outputs** (must match `customer_computers_stack.py`):

| OutputKey | Consumer |
| --- | --- |
| `ComputerClusterName` | `lookup_customer_computer_ecs_config` |
| `ComputerTaskDefinitionArn` | same |
| `ComputerServiceName` | `DescribeServices` → subnets / security groups |

No `ComputerRepositoryUri` (no customer ECR). No `SnapshotBucketName`.

### 2.5 Follow-up on `chatticus-8a25af` (before `3e72dc`)

Before file-actions / hydrate / publish in the customer account:

1. Add scoped `s3:*` to published `customer-role.yml` (customer-visible re-run).
2. Add snapshot bucket resource to customer `ChatticusComputers` template (or `ChatticusComputers*` child stack).
3. Add `CHATTICUS_SNAPSHOT_BUCKET` to task definition and task-role bucket grants.

That work is **not** part of `82dab7`. Do not partially ship a bucket without the policy.

---

## 3. Container image — Anthus ECR pull (no customer replica)

**Wrong (out of scope):**

- ECR layer copy in ComputerWorker Lambda
- Customer ECR repository + `PutImage` under assumed role
- Any path that runs docker inside Lambda

**Correct:**

1. **Preflight (Anthus ops, before live proof):** Anthus `ChatticusComputers` ECR has tag `:dev` (`computer/push-computer-image.sh`). If missing, **stop** — fix ops, do not implement a product copy path.
2. **Customer template:** task definition `image` = Anthus ECR `:dev` URI (full cross-account ARN).
3. **Anthus CDK:** repository policy on Anthus `ComputerImage` repo allowing the customer account's ECS task execution role (created by customer stack, name pattern `ChatticusComputers*`) to `ecr:BatchGetImage` and `ecr:GetDownloadUrlForLayer`.
4. **At RunTask:** Fargate pulls image from Anthus ECR into the customer account. No customer workplace bytes touch Anthus S3.

---

## 4. Gherkin first

### Primary file: `features/cross_account_provisioning.feature`

Add scenarios below the existing host-start block.

```gherkin
  Scenario: A customer organization without ChatticusComputers gets the stack created then RunTask
    Given an organization provisioned into a customer AWS account without a ChatticusComputers stack
    When its computer is asked to start
    Then Chatticus creates the ChatticusComputers stack in the customer account
    And the instance is launched in the customer account
    And no compute for that organization runs in the Anthus account

  Scenario: A customer organization with an existing ChatticusComputers stack only describes it
    Given an organization provisioned into a customer AWS account with a ChatticusComputers stack
    When its computer starts
    Then Chatticus describes the ChatticusComputers stack in the customer account
    And Chatticus does not create the ChatticusComputers stack
    And the instance is launched in the customer account
    And no compute for that organization runs in the Anthus account

  Scenario: A missing ChatticusComputers stack refuses with a visible provisioning error
    Given an organization provisioned into a customer AWS account without a ChatticusComputers stack
    And the host starter cannot provision customer infrastructure
    When its computer is asked to start
    Then the start is refused with a provisioning error naming the missing stack
    And no instance is launched in the Anthus account

  Scenario: An unreachable customer role refuses without creating a stack or launching Anthus compute
    Given an organization whose cross-account role cannot be assumed
    When its computer is asked to start
    Then the start is refused with a provisioning error
    And Chatticus does not create the ChatticusComputers stack
    And no instance is launched in the Anthus account
```

### Step implementation (`features/steps/cross_account_provisioning_steps.py`)

- Extend `_FakeCloudFormation`: `create_stack_calls`, `stack_exists`, `ClientError` on describe when missing.
- Inject `CustomerComputersProvisioner` protocol into `OrganizationComputerHostStarter` (constructor factory param) — production implementation calls real `CreateStack`; Gherkin uses fakes.
- **`And the host starter cannot provision customer infrastructure`:** wire a **test double** provisioner that raises `OrganizationComputerProvisioningError` on missing stack (simulates pre-82dab7 behavior). **No env var** in production Lambda toggling provision on/off.
- Scenario 4: extend existing unreachable-role given with explicit no-`CreateStack` assertion.

### pytest scope (parsers/helpers only)

Keep / extend `python/tests/test_customer_computers_stack.py` for output parsers.

Add pytest for pure helpers only:

- `is_stack_missing_error(ClientError)`
- `template_delivery_for_create_stack(body_bytes)` → `TemplateBody` vs `TemplateURL` decision at 51,200-byte boundary
- `create_stack_capabilities()` → `["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"]`

**No pytest** for CreateStack orchestration, AssumeRole, or RunTask account selection — Gherkin.

---

## 5. Map `DescribeStacks` ClientError → `OrganizationComputerProvisioningError`

**Today:** bare `ClientError` bubbles up; nack message omits CFN reason (`2f2d87`).

**Change** in `organization_computer_host.py` or `customer_computers_stack.py`:

```python
def describe_customer_computers_stack(client, stack_name=COMPUTERS_STACK_NAME):
    try:
        return client.describe_stacks(StackName=stack_name)
    except ClientError as error:
        code = error.response.get("Error", {}).get("Code", "")
        if code in {"ValidationError", "ResourceNotFoundException"} or "does not exist" in str(error):
            raise OrganizationComputerProvisioningError(
                f"{stack_name} stack does not exist in the organization AWS home."
            ) from error
        raise OrganizationComputerProvisioningError(
            f"DescribeStacks({stack_name}) failed: {error}"
        ) from error
```

`ComputerWorker` already maps `OrganizationComputerProvisioningError` → `ComputerWorkerHostNotReady` with the exception text in the message.

Unit-test classifier in pytest; prove refusal text in Gherkin scenario 3 (via test-double provisioner).

---

## 6. Live proof after merge

**Preflight (Anthus ops):**

- Anthus `ChatticusComputers` ECR `:dev` exists (`computer/push-computer-image.sh`). If not, stop.
- Anthus ECR repository policy updated for customer execution-role pull (Anthus CDK deploy).

**Operator path** (from `2f2d87` / wiki — unchanged):

1. Lab org in `CUSTOMER_ACCOUNT_ID`; cross-account role from published URL. **No `members seed`.**
2. Kernel `post_channel_message` (not UI).
3. `prepare_computer_tool(..., request_computer_capability, gate=workspace)` or `browser_open`.
4. `enqueue_computer_continuation(tenant_id, turn_id)`.
5. **Not** `POST .../turns/{id}/resume` while stopped (`ComputerNotReadyError`).

**Evidence:**

| Check | Pass |
| --- | --- |
| CloudTrail `AssumeRole` → customer role | Yes |
| `CreateStack` `ChatticusComputers` in `CUSTOMER_ACCOUNT_ID` | Yes (once) |
| `CreateStack` used `CAPABILITY_IAM` + `CAPABILITY_NAMED_IAM` | Yes |
| ECS `RunTask` in `CUSTOMER_ACCOUNT_ID` | **Yes — primary DoD** |
| ECS `RunTask` in `ANTHUS_ACCOUNT_ID` | **No** |
| Anthus `ChatticusComputers` service desiredCount | **0** |
| Second host start | `DescribeStacks` only; no second `CreateStack` |
| Customer ECR `DescribeImages` | **N/A** — no customer repo this slice |

Record elapsed time separately from ~19 min provision figure. Real ids in `AGENTS.local.md` only; wiki on `develop` via manager.

---

## 7. Hard stops (non-negotiable)

| Stop | Rule |
| --- | --- |
| Silent Anthus `RunTask` | Refuse-not-fallback; zero Anthus `RunTask` when customer home is set |
| `members seed` | Never for lab org |
| `cdk deploy --all` | Never |
| Destroy Anthus `ChatticusSnapshots` / `ChatticusComputers` | Never |
| Anthus `ChatticusComputers` desiredCount > 0 | Never for this card |
| `cdk deploy` Anthus computers stack into customer account | Never |
| Customer second CFN template | Never |
| Edit `customer-role.yml` on this card | Never — bucket/`s3:*` is `8a25af` |
| S3 bucket in customer template this slice | Never — known `CREATE_FAILED` |
| ECR copy / customer ECR replica in ComputerWorker | Never |
| Production env flag to disable auto-provision | Never |
| `POST .../resume` while stopped as proof | Never — use `enqueue_computer_continuation` |
| Lambda `CreateStack` every turn | Wrong — lazy one-shot only |

---

## 8. Worktree and branch

| Item | Value |
| --- | --- |
| Worktree | `/tmp/chatticus-82dab7-customer-computers` |
| Branch | `feat/customer-computers-stack-82dab7` |
| Spike notes | `spikes/82dab7-customer-computers/PLAN.md` (this file) |

Wiki/README on `develop` via manager — not a product PR from this worktree.

---

## Implementation order (for re-authorization)

1. **Gherkin** — four scenarios; test-double provisioner for refusal case; `behave` fails correctly.
2. **Infra** — `CustomerComputersStack` (no bucket, no customer ECR); synth; measure template size; commit artifact; CI drift check.
3. **Anthus ECR policy** — cross-account pull for `ChatticusComputers*` execution role (Anthus CDK on existing repo).
4. **Python** — `ensure_customer_computers_stack` (CreateStack with both IAM capabilities, TemplateBody or TemplateURL); ClientError mapping; wire into `OrganizationComputerHostStarter` via injectable provisioner.
5. **pytest** — error classifier, template delivery helper, capabilities helper.
6. **behave + pytest green** locally.
7. **Product PR** to `develop`.
8. **Live proof** — preflight Anthus `:dev`; kernel path; customer `RunTask` once.

**Out of scope:** snapshot bucket (`8a25af`), file/terminal/browser (`3e72dc`), UI computer tool (`STOP_NO_COMPUTER_TOOL`), staging/production ComputerWorker ECS host start.

---

## Authorization gate

**Do not `CreateStack` in any account until this revised plan is re-authorized.** Anthus `ChatticusComputers` / `ChatticusSnapshots` remain untouched.
