# Owner credential revocation (emergency runbook)

Use this when a credential of the organization computer's owner path is suspected leaked: a supervisor or per-turn AWS
credential, a supervisor, bootstrap or model gateway token, or the token signing key. It is written to be followed at 3 a.m.
by one operator. The design it serves is [Owner credential renewal](OWNER_CREDENTIAL_RENEWAL.md) (decision S6, sections 7.1,
12.1, 12.2 and 12.3) on top of the [Owner supervisor protocol](OWNER_SUPERVISOR_PROTOCOL.md). The blast radius of each
credential is analysed in 12.2 of the renewal contract; this page does not repeat it, it says what to do.

Rules for the whole page:

- **Never print a secret.** No command below prints a token, a key or a credential. If you must handle one, read it from a file
  with mode 0600 or from a pipe, never from a command line, and delete the file afterwards.
- **No account id appears here.** Take the account id from `AGENTS.local.md` when a command needs it. Mask 12-digit ids when
  you paste output anywhere.
- Commands are marked **READ-ONLY** or **DESTRUCTIVE**. A destructive command changes the live system, says what it costs,
  and says how to undo it.
- Everything is written for **development** (profile `chatticus-production`, stack `ChatticusControlPlaneDevelopment`). Staging and
  production have no owner path yet (the signing key secret is created in development only, `control-plane-stack.ts`:
  `if (isDevelopment)`); when they get one, the profile is `chatticus-production` (the one account holds every environment) and the stacks are
  `ChatticusControlPlaneStaging` and `ChatticusControlPlaneProduction`.
- Anything this page could not verify is marked **UNVERIFIED**, with the way to verify it. Section 12 lists them.

## 0. What exists, in one table

| Thing | Name | Where it lives | Lifetime | Who may use it |
| --- | --- | --- | --- | --- |
| Supervisor role | `ComputerSupervisorRole` (CDK construct id; physical name `ChatticusControlPlaneDevelopment-ComputerSupervisorRole...`) | `infra/lib/computer-host-start.ts` | sessions of at most 3600 s | only the broker's execution role may assume it, with exactly two session tags |
| Per-turn role | `ComputerOwnerScopedRole` (same pattern) | the same file | sessions of at most 3600 s | only the broker, with exactly five session tags |
| Credential broker | Lambda `ChatticusControlPlaneDevelopment-OwnerCredentialBroker...` | `conversation/src/lambdas/owner-credential-broker.ts` | | invoked by the Front Door only |
| Signing key | Secrets Manager secret, CDK construct id `ModelGatewaySigningKey`, physical name `ModelGatewaySigningKey<hash>-<suffix>`; its ARN is in `CHATTICUS_MODEL_GATEWAY_SIGNING_KEY_SECRET_ARN` on the Front Door, the ComputerStarter and the broker | `infra/lib/control-plane-stack.ts` | until rotated | those three functions only |
| Bootstrap token | signed with the key; audience `owner-bootstrap` | minted by the ComputerStarter, held in the owner task's container override | 300 s, single use | the supervisor, once |
| Supervisor token | signed with the key; audience `computer-owner` | supervisor memory | at most 3600 s | the owner routes of one computer |
| Model gateway token | signed with the key; audience `model-gateway` | supervisor memory, child over the socket | at most 3600 s | model calls of one turn |
| Invoke key | secret `InvokeKey...`, SSM `/chatticus/<environment>/thin-turn/invoke-key-secret-arn` | CloudFront origin header | until rotated | CloudFront, then the Front Door |
| Operator key | secret `OperatorKey...`, SSM `/chatticus/<environment>/thin-turn/operator-key-secret-arn` | Front Door | until rotated | `POST /operator/orgs/{tenant_id}/{enable,suspend,reinstate}` |

### What is live and what is contract

Phase 2a is live on development. **Phase 2b (renewal) is a contract, not code.** Check before relying on any "after 2b"
sentence: `grep -rl supervisor_renewal conversation/src` prints nothing until the renewal lands.

| | Today (2a) | After Phase 2b |
| --- | --- | --- |
| Supervisor credentials and token | one set, 3600 s, no renewal; the owner drains at 3000 s | renewed every 40 minutes for up to 8 hours |
| A stolen supervisor token | usable for at most one hour | usable while the owner stays live, up to the 8 hour hard end (decision S4) |
| Effect of the session-revoking deny on a live owner | the owner loses its S3 and DynamoDB access and cannot get new credentials; it stops failing, it does not recover | the owner is impaired until its next renewal (up to about 40 minutes), then recovers with a new session |

Each section below says where the two differ.

## 1. Triage: what leaked, whose, since when

Do these in order. All are READ-ONLY. They take about five minutes. Do not skip to containment when the leak is clearly
live (an attacker is acting): go to section 2 first, then come back.

### 1.1 Which kind of credential

| It looks like | It is | Go to the decision table row |
| --- | --- | --- |
| An access key id starting `ASIA`, a secret key and a session token, in a log, a ticket or a paste | an AWS role session (supervisor or per-turn). `aws sts get-caller-identity` with it names the role and the session name (see below) | A or B |
| A string with two dot-separated parts that starts with a version marker, used as `Authorization: Bearer` | a token (bootstrap, supervisor or model gateway); the claims are base64url JSON in the first part, never decode it into a ticket | C, D or E |
| The value of the secret `ModelGatewaySigningKey...`, or a way to read it (`secretsmanager:GetSecretValue` on it, a log line that contains it, a Lambda environment dump) | the signing key | F |
| The CloudFront invoke key, the operator key | not part of the owner path | G |

To tell the role of an AWS credential without acting as it (this uses the leaked credential once, only to ask who it is;
read it from a protected file, not from the command line):

```sh
sh -c 'set -a; . "$LEAKED_CREDENTIALS_FILE"; set +a; aws sts get-caller-identity --query Arn --output text' | sed -E 's/[0-9]{12}/************/g'
```

The result `arn:aws:sts::...:assumed-role/ChatticusControlPlaneDevelopment-ComputerSupervisorRole.../supervisor-<ownerId>` is a
supervisor session; `.../ComputerOwnerScopedRole.../turn-<ownerId>` is a per-turn session. The part after the last slash is
`supervisor-` or `turn-` followed by the owner id (decision R20 of the renewal contract; the 2a broker names the session the
same way, `OWNER_SUPERVISOR_PROTOCOL.md` section 7). If the file is not a credential of those two roles, this runbook does not
apply to it.

### 1.2 Which tenant, computer, owner and turn

The owner id in the session name is the key. Every owner log line carries `tenant_id` and `owner_id`; log lines are one line
per event, `event key=value key=value` (`conversation/src/observability/log-line.ts`).

```sh
export AWS_PROFILE=chatticus-production AWS_REGION=us-east-1
NOW=$(date +%s)
aws logs start-query \
  --log-group-name /aws/lambda/ChatticusControlPlaneDevelopment-OwnerCredentialBroker9BE3FA2-wqqIPWhimLdX \
  --start-time $((NOW - 7200)) --end-time "$NOW" \
  --query-string 'fields @timestamp, @message | filter @message like /owner-OWNER_ID_HERE/ | sort @timestamp asc | limit 50' \
  --query queryId --output text
aws logs get-query-results --query-id QUERY_ID_FROM_ABOVE --query 'results[][?field==`@message`].value[]' --output text
```

(`logs start-query` writes nothing; it is read-only. The group names are current for development; list them with
`aws logs describe-log-groups --log-group-name-prefix /aws/lambda/ChatticusControlPlaneDevelopment --query 'logGroups[].logGroupName' --output text`.)

The owner log lines that exist today, and what each tells you:

| Line | Written by | Tells you |
| --- | --- | --- |
| `owner_token_minted`, `owner_task_started` | ComputerStarter | a bootstrap token was minted for this owner, the task ARN, the start generation |
| `owner_broker_issued` (`purpose=supervisor` or `turn`, `tenant_id`, `owner_id`, `turn_id`) | broker | credentials were issued: when, for which owner, for which turn |
| `owner_broker_refused` (`code=invalid_authorization`, `authorization_mismatch`, `unsafe_tag_value`, `assume_role_failed`, `signing_key_unavailable`, `invalid_request`) | broker | an attempt that failed. A burst of `invalid_authorization` is someone presenting tokens signed with another key, or expired ones |
| `owner_bootstrap_ok`, `owner_bootstrap_refused` | Front Door | the bootstrap exchange; a refused one names a code |
| `owner_stop_decision`, `owner_stopping`, `owner_poll_failed` | Front Door, supervisor | how the owner ended; `owner_poll_failed status=401` is a token the server stopped accepting |
| `component: "model-gateway"` lines (JSON) with `reason` | Front Door | a gateway token refused: `tampered`, `wrong_audience`, `wrong_owner`, `finished_turn`, `wrong_turn`, `organization_mismatch` |

`owner_credentials_refreshed` and the other renewal lines of section 13 of the renewal contract do not exist until 2b lands.
Search for them anyway after 2b; before it, an owner has exactly one `owner_broker_issued purpose=supervisor` and one
`purpose=turn` per turn it served.

Which computer and which task: the task carries tags (`hostTaskTags`, `conversation/src/computer/host-starter.ts`). With the
tenant id from the owner log lines:

```sh
CLUSTER=$(aws ecs list-clusters --query 'clusterArns[?contains(@, `ChatticusComputers-Cluster`)] | [0]' --output text)
aws ecs list-tasks --cluster "$CLUSTER" --desired-status RUNNING --output text
aws ecs describe-tasks --cluster "$CLUSTER" --tasks TASK_ARN_HERE --include TAGS \
  --query 'tasks[].{task:taskArn,started:startedAt,status:lastStatus,tags:tags}' --output json | sed -E 's/[0-9]{12}/************/g'
```

The tags `chatticus:tenant`, `computer_id` and `host_start_generation` name the tenant, the computer and the generation. Do
not add `--query` fields that show `overrides`: the owner task's container override holds the five-minute bootstrap token of
that owner (single use, and spent once the owner bootstrapped, but do not paste it).

A turn id comes from `owner_broker_issued purpose=turn` lines, or from the Messaging table's computer record. The computer
record is read by the Front Door's API: `GET /orgs/{tenant_id}/computer` with a user bearer. Do not read DynamoDB rows by hand
unless the incident needs it; section 9.2 shows the one read that does.

### 1.3 Since when, and is it still happening

- When was the credential issued: the `owner_broker_issued` line for that owner, and the CloudTrail `AssumeRole` event (section
  9.3). A session ends at most 3600 s after it was issued, so a session issued more than an hour ago is already dead on its own.
  **Write down the issue time**; it decides how long the exposure lasted.
- Is it still being used: section 9.3 lists the CloudTrail event names and the Logs Insights queries. If the leak is a
  credential found in a public place, assume it is being used.

## 2. Contain (stop the bleeding before you revoke)

Contain first, because it is cheap and local to one tenant. Revocation (section 3 and later) is global and has a cost for
every organization. Pick the smallest step that works; the decision table in section 8 says which.

### 2.1 Suspend the organization so the computer cannot start again (DESTRUCTIVE for that tenant)

Stopping a task is not enough by itself: the next message the organization's members send starts a new owner with new
credentials. The supported lever to prevent that is the organization lifecycle. A suspended organization is refused by the
ComputerStarter (`organizationNotEnabledReason`, `conversation/src/domain/computer-start.ts`) and by the user routes, which
require an enabled member (`requireEnabledMember`, `conversation/src/auth/principal.ts`).

There is **no operator route that stops a computer or marks it stopped, and no per-computer disable flag.** The routes that
exist are the three below. The route that sets `stopped` (`POST /orgs/{tenant_id}/host/computer/state`) takes a worker or owner
credential and is for the owner itself; do not call it as an operator.

Two ways, one implementation (`docs/OPERATOR_ORG_SEED.md`):

```sh
node conversation/bin/members.ts suspend TENANT_ID --yes
```

needs `CHATTICUS_MESSAGING_TABLE` and AWS credentials for the environment; or the operator route, with the operator bearer read
from the secret into a protected stream (the bearer never touches the command line or the terminal):

```sh
BASE=$(aws ssm get-parameter --name /chatticus/development/thin-turn/cloudfront-url --query Parameter.Value --output text)
OPERATOR_ARN=$(aws ssm get-parameter --name /chatticus/development/thin-turn/operator-key-secret-arn --query Parameter.Value --output text)
aws secretsmanager get-secret-value --secret-id "$OPERATOR_ARN" --query SecretString --output text \
  | { read -r OPERATOR_KEY; printf 'header = "Authorization: Bearer %s"\n' "$OPERATOR_KEY" | curl -sS --config - -X POST "$BASE/operator/orgs/TENANT_ID/suspend" -o /dev/null -w '%{http_code}\n'; }
```

Expect `200`. The CloudFront invoke key is added by CloudFront itself on this path. **Cost:** every member of that organization
is refused until `reinstate`. **Undo:** the same command with `reinstate` (not `enable`, which accepts `pending` only).
Suspension does not stop an owner that is already running: the owner routes do not look at the organization status. That is
what 2.2 is for. **Do not suspend every organization to contain one tenant's leak.** Suspend only the tenants whose owner ids
appeared in triage.

### 2.2 Stop the owner task (DESTRUCTIVE for that tenant's running computer)

```sh
aws ecs stop-task --cluster "$CLUSTER" --task TASK_ARN_HERE --reason "credential leak, runbook OWNER_CREDENTIAL_REVOCATION"
```

**Cost:** the computer loses everything it has not published to its snapshot: files written to its disk since the last
publish. The task gets SIGTERM and Fargate allows its stop timeout; the supervisor's SIGTERM path publishes if it can
(`SUPERVISOR_EXIT_SIGTERM`, exit 143), but do not count on it, and if the supervisor's S3 credentials are the leaked thing,
you would rather it did not. An approved edit that sits in the overlay is in S3 under the Front Door's control and survives.
**Who:** anyone with `ecs:StopTask` on the cluster (the operator profile). **Undo:** none for the task; the computer starts
again at the next member message, if the organization is enabled.

What the control plane does afterwards: the owner's heartbeat stops, and after `DEFAULT_HEARTBEAT_TIMEOUT_SECONDS` (30)
the control plane settles the computer as lost (`settleLostComputerHost`, `conversation/src/domain/computers.ts`), clears the
owner and parks any turn it was serving for recovery by the next owner. A stopped or replaced owner is no longer the live
owner, so the owner routes answer its token with 403 `not_current_owner` (or `stale_generation`), and the supervisor, if it is
still running, exits with code 5 (`SUPERVISOR_EXIT_SUPERSEDED`) and publishes nothing. This is the supported way to "mark the
computer stopped": the control plane does it itself when the owner is gone.

**Verify (READ-ONLY):**

```sh
aws ecs describe-tasks --cluster "$CLUSTER" --tasks TASK_ARN_HERE --query 'tasks[].{status:lastStatus,reason:stoppedReason,exit:containers[].exitCode}' --output json
```

`lastStatus` becomes `STOPPED` within about a minute. Then `GET /orgs/{tenant_id}/computer` (a member's bearer) shows no owner
after the 30 second heartbeat window. What a stop does not do: it does not invalidate the credentials already issued. A
supervisor session stays valid to its own expiry (at most an hour after it was issued), and a stolen copy works from
anywhere. Containing the task only removes the legitimate holder and the leaked token's usefulness against the owner routes;
revoking the session is section 3.

## 3. Revoke the role sessions (DESTRUCTIVE, global to the environment)

AWS cannot revoke one session of a role. The standard technique, which the console offers as "Revoke active sessions", is a
deny on the role for every session whose `aws:TokenIssueTime` is before a time. It hits every tenant's sessions of the role at
once. Use it when a leaked AWS credential is still valid (issued less than an hour ago) and containing one tenant is not
enough, or when the signing key leaked (section 5 does this as its second step).

**The broker keeps working.** The deny is an identity policy on the role being assumed. It is evaluated when that role's
session makes a request. The broker's `sts:AssumeRole` call is authorized by the broker's own execution role and by the
role's trust policy, not by the role's identity policies, and a session issued after the timestamp has a later
`aws:TokenIssueTime`, so the deny does not match it. Therefore the sequence "put the deny with T = now, then the broker issues
a session at T + 1 s" works. This is the documented behaviour of `aws:TokenIssueTime` denies; it is **UNVERIFIED on a live
broker** (the policy shape below is verified by the simulator, section 3.3, but no deny was attached to a live role while
writing this page). Verify it with the check in 3.4.

### 3.1 The two ways, and which to use

| | CDK change, deployed by the normal path | Break-glass `put-role-policy` |
| --- | --- | --- |
| Source of truth | stays the repository | the live role only; invisible to CDK and to review |
| Time to effect | a PR, a green CI, a deploy of the ControlPlane stack: tens of minutes | seconds |
| Drift | none | an inline policy CloudFormation does not know. **UNVERIFIED:** CloudFormation does not remove an inline policy it did not create (the roles' CDK policies are separate `AWS::IAM::Policy` resources: `ComputerSupervisorRoleDefaultPolicy...`). Verify with `aws iam list-role-policies` after the next deploy |
| When | the leak is stale or contained, and you want the deny to survive redeploys | the leak is live and every minute counts |

AGENTS.md says AWS resources exist as CDK only. A revocation deny is an incident control that has to exist faster than a
deploy, so the break-glass path is allowed here, with three conditions: it uses the CLI against the environment's own profile
(never the console, never a copied key), it is recorded in the incident Kanbus issue the moment it is put (policy name, time
`T`, who), and it is removed in section 7. There is **no CDK switch for this today**. If an incident shows the need, the CDK
change is a small follow-up (a stack property `ownerSessionRevokedBefore?: string`, from CDK context
`ownerSessionRevokedBefore`, that adds the same Deny statement to both roles in `wireComputerStarterOwnerRunTask`); it is
**not built**, create a Kanbus issue for it in the post-incident review (section 11).

### 3.2 Put the deny (DESTRUCTIVE)

Set `T` to the current UTC time. Sessions issued before `T` are denied; sessions issued at or after `T` are not. Do not set
`T` in the future: a session the broker issues between now and `T` would be denied too, and the live system would fail until
`T` passes.

```sh
export AWS_PROFILE=chatticus-production AWS_REGION=us-east-1
REVOKE_BEFORE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "$REVOKE_BEFORE"
SUPERVISOR_ROLE=ChatticusControlPlaneDevelopment-ComputerSupervisorRoleE300F7A-i6M9lsa1Kouv
SCOPED_ROLE=ChatticusControlPlaneDevelopment-ComputerOwnerScopedRoleF18EE4-kb5WDKtzV8l1
DENY_DOCUMENT=$(printf '{"Version":"2012-10-17","Statement":{"Effect":"Deny","Action":"*","Resource":"*","Condition":{"DateLessThan":{"aws:TokenIssueTime":"%s"}}}}' "$REVOKE_BEFORE")
aws iam put-role-policy --role-name "$SUPERVISOR_ROLE" --policy-name AWSRevokeOlderSessions --policy-document "$DENY_DOCUMENT"
aws iam put-role-policy --role-name "$SCOPED_ROLE" --policy-name AWSRevokeOlderSessions --policy-document "$DENY_DOCUMENT"
```

The physical role names above are the development ones as of this writing; re-derive them (READ-ONLY) when in doubt:

```sh
aws cloudformation describe-stack-resources --stack-name ChatticusControlPlaneDevelopment \
  --query "StackResources[?ResourceType=='AWS::IAM::Role' && (starts_with(LogicalResourceId,'ComputerSupervisorRole') || starts_with(LogicalResourceId,'ComputerOwnerScopedRole'))].[LogicalResourceId,PhysicalResourceId]" --output text
```

`AWSRevokeOlderSessions` is the name the console's own "Revoke active sessions" uses; if a policy of that name exists
(`aws iam list-role-policies --role-name "$SUPERVISOR_ROLE"`), this command replaces it, which moves `T` forward and is what you
want. Put both policies in one go; a half-revoked pair leaves the other role's leaked sessions alive.

**Cost:** every live supervisor and every live turn in the environment loses its AWS access at once: S3 snapshot publishes
and Pi session and conversation writes fail with `AccessDenied`.
- Today (2a): those owners cannot recover; each ends (the turn fails, the owner drains or is lost) and the computer restarts
  at the next message, from its last published snapshot. Unpublished disk state is lost.
- After 2b: each owner is impaired until its next renewal (up to about 40 minutes, since renewal starts 1200 s before a 3600 s
  session ends), then continues on a new session. Publishes and turn writes in the gap fail and are retried.

**Who:** an operator with `iam:PutRolePolicy` on the two roles. **Undo:** section 7 (delete the policy). The deny never expires
on its own; a forgotten deny breaks nothing that is issued after `T`, but it would deny any session whose clock makes it earlier
than `T`, so remove it.

### 3.3 Prove the deny works without attaching it (READ-ONLY dry run)

The IAM policy simulator accepts an extra policy and a session issue time, so the exact document above can be checked against
the real role with nothing changed. This was run on development while writing this page. `DENY_DOCUMENT` is the one built in
3.2; to dry-run without putting it, build the variable only:

```sh
REVOKE_BEFORE=2026-10-14T03:00:00Z
DENY_DOCUMENT=$(printf '{"Version":"2012-10-17","Statement":{"Effect":"Deny","Action":"*","Resource":"*","Condition":{"DateLessThan":{"aws:TokenIssueTime":"%s"}}}}' "$REVOKE_BEFORE")
SUPERVISOR_ARN=$(aws lambda get-function-configuration --function-name ChatticusControlPlaneDevelopment-OwnerCredentialBroker9BE3FA2-wqqIPWhimLdX --query Environment.Variables.CHATTICUS_OWNER_SUPERVISOR_ROLE_ARN --output text)
BUCKET=$(aws lambda get-function-configuration --function-name ChatticusControlPlaneDevelopment-FrontDoor201A7CE0-GIZcTzywOZCI --query Environment.Variables.CHATTICUS_SNAPSHOT_BUCKET --output text)
for ISSUED in 2026-10-14T02:00:00Z 2026-10-14T04:00:00Z; do
  aws iam simulate-principal-policy --policy-source-arn "$SUPERVISOR_ARN" --policy-input-list "$DENY_DOCUMENT" \
    --action-names s3:GetObject --resource-arns "arn:aws:s3:::$BUCKET/tenants/t1/computers/c1/x" \
    --context-entries ContextKeyName=aws:TokenIssueTime,ContextKeyValues=$ISSUED,ContextKeyType=date \
      ContextKeyName=aws:PrincipalTag/tenant,ContextKeyValues=t1,ContextKeyType=string \
      ContextKeyName=aws:PrincipalTag/computer,ContextKeyValues=c1,ContextKeyType=string \
    --query 'EvaluationResults[].EvalDecision' --output text
done
```

With a deny whose `T` is `2026-10-14T03:00:00Z`, the session issued at `02:00` printed `explicitDeny` and the one issued at
`04:00` printed `allowed`; the same question with no extra policy printed `allowed` for the old session. That is the whole
claim of the technique, checked against the real role: old sessions denied, new sessions untouched. Run it against the owner
per-turn role the same way with an action from its policy (`conversation/src/gateway/owner-role-policy.json`).

### 3.4 Prove the deny works on the live roles after step 3.2 (READ-ONLY)

1. The policy is present, and its time is the one you intended:
   ```sh
   aws iam get-role-policy --role-name "$SUPERVISOR_ROLE" --policy-name AWSRevokeOlderSessions --query PolicyDocument --output json
   aws iam get-role-policy --role-name "$SCOPED_ROLE" --policy-name AWSRevokeOlderSessions --query PolicyDocument --output json
   ```
2. The manifest check still passes. `conversation/bin/simulate-role-access.ts` puts the 42 request shapes of the role access
   manifest to the simulator **without** an issue time, so a `aws:TokenIssueTime` deny does not match them and every case still
   reads allowed (reasoned from how the simulator treats an absent condition key; **UNVERIFIED** with a live attached deny). That is the expected result and it is what the check is for here: it proves the roles' own permissions did
   not change. It does not prove the deny.
   ```sh
   cd conversation && npx tsx bin/simulate-role-access.ts --environment development
   ```
   Expect `PASS role access development: 42 of 42 allowed (frontDoor 12, ownerTurn 28, supervisor 2)`. (Run read-only on
   development while writing this page, before any deny existed.) If the SDK complains the SSO token is expired although the
   AWS CLI works, export the CLI's credentials first: `eval "$(aws configure export-credentials --profile chatticus-production --format env)"`.
3. The deny proof is section 3.3 with the real `T`, and the live proof is the next step: the broker still issues.
4. **The broker is not locked out:** cause one fresh issue (a member sends a message that needs the computer, section 10.1) and
   look for `owner_broker_issued` in the broker log group with a timestamp after `T`, and a CloudTrail `AssumeRole` with that
   owner's session name (section 9.3). If you instead see `owner_broker_refused code=assume_role_failed`, the deny is being
   applied to the broker's `AssumeRole`, which this page's reasoning says it is not: delete the policy at once (section 7) and
   record the surprise.

## 4. The supervisor token, the bootstrap token and the gateway token

A token is only useful while the control plane accepts it. These are all stateless HMAC tokens (decision R19: no rotating
serial), so there is **no per-token revocation**. What exists is the control plane's own checks, which you can trigger:

| Token | What stops it without touching the key |
| --- | --- |
| Bootstrap token (audience `owner-bootstrap`) | it is single use and lives 300 s. Once the owner bootstrapped it is a 409. If it leaked before the owner used it, stop the task (2.2): the legitimate bootstrap never happens, the generation moves on, and the leaked token is refused (`stale_generation`) |
| Supervisor token (audience `computer-owner`) | stop the owner (2.2). The token names an owner id and a generation; once the owner is not the live owner of the current generation every owner route answers 403 (`not_current_owner`, `stale_generation`). After 2b the same refusal also ends renewal. The window until then is the token's own expiry, at most an hour (today) and at most the owner's life (after 2b, decision S4) |
| Model gateway token (audience `model-gateway`) | end the turn. The gateway refuses a token whose turn is not `active` (`finished_turn`) or not claimed by the token's owner (`wrong_owner`) (`conversation/src/gateway/model-gateway.ts`). Stop the owner (2.2): the turn is parked or failed and the claim moves. No operator route fails a single turn |

If you must kill every token of every kind at once, or the key is what leaked, the only lever is section 5.

## 5. Rotate the signing key (DESTRUCTIVE, global, the last resort)

The key signs all three token kinds. Anyone holding it can mint a bootstrap token for any tenant and have the broker turn it
into supervisor credentials, or mint a supervisor token or a gateway token directly. Revoking sessions and stopping tasks do
not help against a leaked key, because the attacker mints new tokens. Rotate the key first, then revoke sessions (section 3) to
kill whatever the forged tokens already obtained.

**There is no signing-key rotation script.** `infra/rotate-invoke-key.sh` rotates the invoke key only (section 6). The
signing key has no `AWSPREVIOUS` fallback: the Front Door, the ComputerStarter and the broker each read one secret value and
verify and sign with it, so unlike the invoke key there is no overlap window, and a rotation invalidates every token at once.
The steps below are manual.

### 5.1 What it costs, before you do it

- Every supervisor token, bootstrap token and gateway token ever minted becomes invalid as soon as a function has read the new
  value (see 5.3 for how fast).
- Every running owner gets 401 on its next poll and exits with code 5 (`SUPERVISOR_EXIT_SUPERSEDED`), **publishing nothing**.
  What is lost is everything on each computer's disk that was written since its last published snapshot. Look at how stale that
  is before you rotate, if there is time (READ-ONLY): the newest object under the computer's snapshot prefix
  `tenants/<tenant_id>/computers/<computer_id>/` in the snapshot bucket (`aws s3 ls s3://$BUCKET/tenants/TENANT_ID/computers/COMPUTER_ID/ --recursive | sort | tail -3`).
  Live-file edits that were not yet saved show in the UI as "not yet in the saved copy" and are lost with them (design decision
  O4 of `LIVE_FILES_PROTOCOL.md`).
- Every turn in flight fails at its next model call (gateway 401 `tampered`). The turn is parked or failed and recovered by the
  next owner (lost-owner recovery); the member sees the turn fail or wait, then continue after the computer starts again. The
  exact message text is **UNVERIFIED**; verify by running section 10.1 and reading what the web app shows.
- The computer starts again at the next message that needs it: one cold start of about 30 seconds (the figure of P2 in the
  renewal contract; **UNVERIFIED** here), from the last published snapshot.
- Web sign-in is unaffected: member sessions are Cognito, not these tokens. **UNVERIFIED** that no other session kind shares the
  key: `grep -rn "mintSessionToken\|mintComputerOwnerToken\|mintOwnerBootstrapToken" conversation/src` lists the only
  minters (the broker and the owner start driver at the time of writing).
- A start job that the ComputerStarter queued with a bootstrap token minted under the old key fails its bootstrap (supervisor exit
  6); the starter's retry mints under the new key once it has read it.

Do not rotate the key to contain a leak of one supervisor credential or one gateway token. Section 2 and 3 are cheaper.

### 5.2 Steps (DESTRUCTIVE)

```sh
export AWS_PROFILE=chatticus-production AWS_REGION=us-east-1
SECRET_ARN=$(aws lambda get-function-configuration --function-name ChatticusControlPlaneDevelopment-FrontDoor201A7CE0-GIZcTzywOZCI --query Environment.Variables.CHATTICUS_MODEL_GATEWAY_SIGNING_KEY_SECRET_ARN --output text)
aws secretsmanager list-secret-version-ids --secret-id "$SECRET_ARN" --query 'Versions[].[VersionId,VersionStages[0]]' --output text
```

(READ-ONLY. Note the current version id; it becomes `AWSPREVIOUS` after step 1.)

1. Put a new value. 64 characters without punctuation is what the stack generates (`MODEL_GATEWAY_SIGNING_KEY_LENGTH`; the
   code refuses a key under 32). The value never appears on a command line or in the terminal, the pattern of
   `infra/rotate-invoke-key.sh`:
   ```sh
   aws secretsmanager get-random-password --password-length 64 --exclude-punctuation --query RandomPassword --output text \
     | aws secretsmanager put-secret-value --secret-id "$SECRET_ARN" --secret-string file:///dev/stdin --query VersionId --output text
   ```
2. Make the three readers re-read it. The Front Door and the ComputerStarter read the secret once when their code first
   composes in a container (`front-door-composition.ts`, `computer-starter.ts`), and keep it for the life of the container, so
   a warm container keeps the old key for hours. The broker caches it for 300 s (`BROKER_SIGNING_KEY_CACHE_SECONDS`). A
   configuration change makes new invocations start new execution environments, which re-read the secret. Change the
   description to a timestamp (the one setting nothing depends on):
   ```sh
   for FUNCTION in ChatticusControlPlaneDevelopment-FrontDoor201A7CE0-GIZcTzywOZCI ChatticusControlPlaneDevelopment-ComputerStarterFFA18BAD-oE2OhAMuk3jz ChatticusControlPlaneDevelopment-OwnerCredentialBroker9BE3FA2-wqqIPWhimLdX; do
     aws lambda update-function-configuration --function-name "$FUNCTION" --description "signing key rotated $(date -u +%Y-%m-%dT%H:%M:%SZ)" --query LastUpdateStatus --output text
     aws lambda wait function-updated-v2 --function-name "$FUNCTION"
   done
   ```
   That a description change recycles warm execution environments is how Lambda treats any configuration update;
   it is **UNVERIFIED** on this deployment. Verify as in 5.4. The next normal deploy resets the description (harmless drift).
   Updating the configuration does not change the environment variables; never pass `--environment` here, it replaces them all.
3. Retire the old value so it can no longer be read by stage label (the old key is the leaked one):
   ```sh
   aws secretsmanager update-secret-version-stage --secret-id "$SECRET_ARN" --version-stage AWSPREVIOUS --remove-from-version-id OLD_VERSION_ID_FROM_ABOVE
   ```
   A version with no stage is deleted by Secrets Manager in due course, but it can still be read by version id until then by
   anyone with `GetSecretValue`: if the leak was access to the secret itself, also fix who has that permission (section 11).
4. Revoke the sessions (section 3). Tokens signed with the leaked key may already have been exchanged for AWS credentials; the
   deny ends them. Use the time `T` of the moment after step 2 completed.
5. Stop every running owner task (2.2) rather than waiting for their 401: they would exit by themselves within one poll
   interval, but a stopped task is certain. List them all with `aws ecs list-tasks --cluster "$CLUSTER" --desired-status RUNNING`.

**Who:** the operator profile with `secretsmanager:PutSecretValue` and `lambda:UpdateFunctionConfiguration`.
**Undo:** none that is useful. Putting the old value back re-validates every token minted under it, including a forged one;
never do it.

### 5.3 How fast it takes effect

- The broker: at most 300 s (cache), or immediately after step 2.
- The Front Door and the ComputerStarter: only after step 2. Without step 2 a warm container keeps accepting old tokens, and
  minting new ones with the old key, indefinitely.
- Tokens already issued and not yet presented are dead on first use after the reader has the new key. There is no grace.

### 5.4 Verify the key is rotated (READ-ONLY)

- The secret has a new `AWSCURRENT` and no `AWSPREVIOUS`:
  `aws secretsmanager list-secret-version-ids --secret-id "$SECRET_ARN" --query 'Versions[].[VersionId,VersionStages]' --output json`.
- The functions are new: each shows a new `Last modified` (`aws lambda get-function-configuration --function-name F --query '[LastModified,Description,LastUpdateStatus]' --output text`),
  and the first invocation after that logs an `INIT_START` / `Init Duration` in its log group (a cold start).
- An old token is dead. The honest proof without minting a token: the owners' own behaviour. For every owner task you stopped or
  that was running, `owner_poll_failed status=401` in the Front Door's logs, and the ECS task's container exit code is 5:
  `aws ecs describe-tasks --cluster "$CLUSTER" --tasks TASK_ARN --query 'tasks[].containers[].exitCode' --output text`.
  And no `owner_broker_issued` for those owner ids after the rotation time. If you hold the leaked token itself (from the
  incident evidence), present it once to an owner route and expect 401:
  `printf 'header = "Authorization: Bearer %s"\n' "$(cat LEAKED_TOKEN_FILE)" | curl -sS --config - -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/orgs/TENANT_ID/host/owner/poll" -o /dev/null -w '%{http_code}\n'`.
  The path needs a request body the route accepts to reach its token check; a 401 for an invalid signature comes before body
  validation (route order in `owner-host-auth.ts`; **UNVERIFIED**, a 422 would mean the body was checked first, in which case
  use a real poll body from a test fixture).

## 6. The model gateway token, the invoke key and the other keys

**Model gateway token** (leaked, key not): section 4 row 3. Its reach is model calls of one turn for at most an hour; the
vendor key (`OPENAI_API_KEY`) is held by the Front Door and never given to the owner. Look at spend with the gateway
observation rows (section 9.2) and the vendor dashboard.

**Invoke key** (the shared CloudFront origin header; a Function URL bypass): rotate with `infra/rotate-invoke-key.sh`, which is
the model for a safe rotation: refuses without `--yes`, keeps the previous value staged (`AWSPREVIOUS`) so nothing breaks while
CloudFront catches up, compares the origin header with the secret in memory without printing it, and only then retires the old
value. Read `docs/AWS_AUTH.md`, "Rotating the invoke key", for the order and the window. READ-ONLY first:

```sh
cd infra
sh rotate-invoke-key.sh development --dry-run
```

Then DESTRUCTIVE (several minutes: it waits 65 s twice and waits for a CloudFront deployment):

```sh
sh rotate-invoke-key.sh development --yes
```

It does not touch the owner path: owner routes and the model gateway are authenticated by their tokens, not by the invoke
key. If it stops halfway, `--resume --yes` finishes. If it is suspected leaked, do not stop between "put" and "retire"
(AWS_AUTH.md, "The window").

**Operator key** (`OperatorKey...`): a leaked key lets someone suspend or reinstate organizations. There is no rotation script
and no runbook yet; the manual shape is the invoke key's without the CloudFront step (`put-secret-value`, then force the Front
Door to re-read it as in 5.2 step 2, which reads it at composition, `front-door-composition.ts`). Out of scope here.

## 7. After containment: remove the deny

Only after the leaked credential has expired on its own (one hour after the **latest** issue of anything that could have been
stolen) and the incident is understood. Removing the deny never revives a session issued before `T` for long (it expires on its
own within the hour), but it does let any session issued after `T` act. If a credential leaked again after `T`, do not remove
the deny: put a new, later `T` (section 3.2 replaces the policy).

```sh
aws iam delete-role-policy --role-name "$SUPERVISOR_ROLE" --policy-name AWSRevokeOlderSessions
aws iam delete-role-policy --role-name "$SCOPED_ROLE" --policy-name AWSRevokeOlderSessions
aws iam list-role-policies --role-name "$SUPERVISOR_ROLE" --output text
aws iam list-role-policies --role-name "$SCOPED_ROLE" --output text
```

(The first two are DESTRUCTIVE only in that they lift the protection; the last two are READ-ONLY.) Each role should list only
its CDK policy, `ComputerSupervisorRoleDefaultPolicy...` and `ComputerOwnerScopedRoleDefaultPolicy...`. Also reinstate any
organization you suspended (2.1) once its computer is safe to start again.

## 8. Decision table

Cheapest sufficient action first. "Then" means in this order.

| # | What leaked | Others affected | Do | Cost | Who |
| --- | --- | --- | --- | --- | --- |
| A | One **supervisor AWS credential** (the `supervisor-<ownerId>` session) | the reach is one computer's snapshot prefix, not the overlay (an explicit deny), nothing in DynamoDB or STS | 2.1 suspend the tenant, then 2.2 stop its task. If the credential is under an hour old and you cannot wait for it to expire: 3.2 for both roles | one tenant down; with 3.2 every tenant's owners lose access | operator |
| B | One **per-turn AWS credential** (`turn-<ownerId>`) | one conversation's Pi session and items | 2.2 stop the task, which fails or parks the turn. 3.2 if under an hour old and the content is sensitive | as A | operator |
| C | One **supervisor token** (no AWS keys) | owner routes of one computer; poll as the owner and obtain per-turn credentials for parked turns | 2.2 stop the task (the token is refused at once because the owner is no longer live). Then 3.2 if per-turn credentials may already have been obtained (look for unexplained `owner_broker_issued purpose=turn` for that owner in triage) | one tenant restarts | operator |
| D | One **model gateway token** | model calls of one turn | end the turn; if you cannot, 2.2 | one turn lost | operator |
| E | A **bootstrap token** before use | one owner start | 2.2 stop that task; the generation moves on | one start retried | operator |
| F | The **signing key** (or the right to read the secret) | everything: any token for any tenant | section 5 steps 1 to 5 (rotate, make the functions re-read, retire the old value, revoke sessions, stop all owners) | every owner stops, unpublished work is lost, every turn in flight fails | operator with `secretsmanager:PutSecretValue` |
| G | The **invoke key** | bypass of CloudFront on non-owner routes | `rotate-invoke-key.sh` (section 6) | minutes; customer host workers (staging, production) need a restart | operator |
| H | **Unknown** which credential, but a session is acting from outside the task | possibly several | 3.2 (both roles) immediately, then triage with the CloudTrail queries (9.3) while the sessions die; escalate to F if `AssumeRole` calls come from a principal other than the broker | environment-wide owner interruption | operator |
| I | **Proof of misuse by a member** (not a leak) | not a credential problem | out of scope; use the audit trail (section 9.1) and the organization lifecycle (2.1) | | operator |

## 9. Check the audit trail: what was reachable and what was done

The goal is to bound what the credential could do and what it did. Three sources, each with a limit.

### 9.1 The Front Door's file audit records (what members and the owner did through the Front Door)

Every member write, reveal, delete, move and directory creation on the organization computer's files, and every overlay
change, has a record written **before** the action and finished by its result (`LIVE_FILES_PROTOCOL.md` decision L21, L29,
L44). Partition `<tenant_id>#computer#audit`, sort key `at#<13-digit epoch ms>#<operation id>`, retained 90 days (`expires_at`
TTL). A record holds `user_id`, `owner_id`, `operation`, `path`, `outcome`, hashes and sizes, `flags` (`integrity_mismatch` is
the one to look for), never content. There is no HTTP route for it (decision O4: operators read the table).

READ-ONLY:

```sh
TABLE=$(aws lambda get-function-configuration --function-name ChatticusControlPlaneDevelopment-FrontDoor201A7CE0-GIZcTzywOZCI --query Environment.Variables.CHATTICUS_MESSAGING_TABLE --output text)
FROM_MS=$(( ($(date +%s) - 86400) * 1000 ))
aws dynamodb query --table-name "$TABLE" \
  --key-condition-expression 'pk = :pk AND sk >= :from' \
  --expression-attribute-values "{\":pk\":{\"S\":\"TENANT_ID#computer#audit\"},\":from\":{\"S\":\"at#$(printf '%013d' "$FROM_MS")\"}}" \
  --projection-expression '#at, user_id, owner_id, operation, #p, outcome, flags' \
  --expression-attribute-names '{"#at":"at","#p":"path"}' --output json
```

(The query shape was run against development with no matching tenant and returned a count of 0; the projection and names
are **UNVERIFIED** against a populated tenant.)

Limit: this trail records what went **through the Front Door**. A stolen supervisor credential talks to S3 directly, so what
it did to the snapshot prefix is **not** in this trail. A stolen per-turn credential talks to DynamoDB and the Pi sessions
bucket directly, likewise.

### 9.2 Ledger rows (what the model gateway forwarded)

Every model call the gateway forwarded is kept as an observation: partition `<tenant_id>#cost#observed`, sort key
`turn#<turn_id>#call#<call_id>`, with `owner_id`, model and token counts, kept 35 days
(`conversation/src/ledger/gateway-observation.ts`). Use it to see what a leaked gateway token or a forged one spent.

```sh
aws dynamodb query --table-name "$TABLE" --key-condition-expression 'pk = :pk' \
  --expression-attribute-values '{":pk":{"S":"TENANT_ID#cost#observed"}}' --select COUNT --output text
```

Drop `--select COUNT` and add a `--projection-expression` for the rows. Compare the owner ids and turns with the legitimate
ones from triage; a call whose `owner_id` was not the claimant at the time is the gateway's refusal case and should not exist
(the gateway checks that the turn is active and claimed by the token's owner).

### 9.3 CloudTrail (who obtained credentials, and what changed)

Management events are the only ones available on development at the time of writing: `aws cloudtrail describe-trails`
returned no trail, so the 90 day Event history (`lookup-events`) is all there is, and **S3 and DynamoDB data events are not
recorded**. That means CloudTrail can tell you who was issued a session, never what the session did. Confirm for the
environment you are in (READ-ONLY): `aws cloudtrail describe-trails --query 'trailList[].Name' --output text` and
`aws cloudtrail get-event-selectors --trail-name NAME`. Staging and production are **UNVERIFIED**.

Event names to look for:

| `eventName` | Why | Suspicious when |
| --- | --- | --- |
| `AssumeRole` on the two roles | a session was issued; `userIdentity.arn` is the caller, `requestParameters.roleSessionName` is `supervisor-<ownerId>` or `turn-<ownerId>` | the caller is not the broker's execution role (the trust policy forbids it, so this would mean the trust policy changed); a session name with an owner id the control plane never started; a burst |
| `GetSecretValue` on the signing key | who read the key | any principal other than the Front Door, the ComputerStarter and the broker execution roles |
| `PutSecretValue`, `UpdateSecretVersionStage` | the key or its stages changed | not you |
| `PutRolePolicy`, `AttachRolePolicy`, `UpdateAssumeRolePolicy`, `DeleteRolePolicy` on the two roles | the roles' permissions or trust changed | not the deploy role, not you |
| `UpdateFunctionConfiguration`, `UpdateFunctionCode` on the broker | its environment, including the role ARNs and the secret ARN, changed | not the deploy role |
| `RunTask`, `StopTask` on the computers cluster | owner tasks | not the starter or you |

```sh
aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRole --max-results 50 \
  --query 'Events[].CloudTrailEvent' --output json \
  | jq -r '.[] | fromjson | select((.requestParameters.roleArn // "") | test("ComputerSupervisorRole|ComputerOwnerScopedRole")) | [.eventTime, .userIdentity.arn, .requestParameters.roleSessionName, .sourceIPAddress] | @tsv' \
  | sed -E 's/[0-9]{12}/************/g'
```

(Run on development: the shell pipeline parses and prints the event fields `roleArn` and `roleSessionName`; no event for these
two roles was in the newest 20 at the time, so the printed row format is **UNVERIFIED** on a real match.) Repeat with
`--max-results 50` and the event names above; `lookup-events` returns 50 per call at most and only the last 90 days of
management events. A matching `AssumeRole` count per owner id against `owner_broker_issued` lines is the reconciliation: every
session must have a broker log line, and every broker line a session.

After 2b, add the `owner_credentials_refreshed` lines (supervisor log group, `kind`, `expires_at`): the reachable window of a
stolen supervisor token is the span from the first to the last `AssumeRole` for that owner id, at most 8 hours.

### 9.4 What was reachable, in one sentence per credential

Use 12.2 of the renewal contract. A supervisor credential reached one computer's snapshot prefix (read, write, abort multipart;
not the overlay) for at most an hour from each issue; a per-turn credential reached one conversation's Pi session and items; a
gateway token reached model calls of one turn; the signing key reached everything.

## 10. Recovery and verification

### 10.1 A live computer turn works

After the deny is lifted (section 7) or, if it stays, after its time `T` is behind you, prove the owner path end to end on
the environment:

1. The role manifest check, READ-ONLY: `cd conversation && npx tsx bin/simulate-role-access.ts --environment development`
   expects `PASS ... 42 of 42 allowed`.
2. Sign in at `https://develop.chattic.us` and send a message that needs the computer (ask the bot to run `echo ok` in the shell).
   A cold start takes about 30 seconds. The reply comes back; the turn is not failed.
3. In the logs: the ComputerStarter shows `owner_token_minted`, `owner_task_started`; the Front Door shows `owner_bootstrap_ok`;
   the broker shows `owner_broker_issued purpose=supervisor` then `purpose=turn`, both timestamped after `T` (or after the key
   rotation). No `owner_broker_refused`.
4. The acceptance runner, which AGENTS.md names as the black-box check of a deployed environment:
   `cd conversation && npx tsx bin/acceptance.ts --environment development`. Whether it includes a computer turn is
   **UNVERIFIED**; read its scenario list before you rely on it and fall back to step 2.

### 10.2 Prove the revoked credential is dead

| Credential | Proof | Expected |
| --- | --- | --- |
| AWS session (supervisor or per-turn) | with the leaked credentials from a protected file: `aws s3api head-object --bucket $BUCKET --key tenants/TENANT_ID/computers/COMPUTER_ID/anything` (supervisor) | `AccessDenied` with an explicit deny in an identity-based policy. `aws sts get-caller-identity` still works for any session (STS cannot be denied), so it proves nothing. Once the session expired on its own the error is `ExpiredToken` instead |
| Supervisor token | present it to `POST /orgs/{tenant_id}/host/owner/poll` (5.4) | 401 after a key rotation; 403 `not_current_owner` or `stale_generation` after the owner is stopped |
| Gateway token | present it to `POST /orgs/{tenant_id}/model-gateway/v1/responses` | 401 after a rotation; 403 `finished_turn` or `wrong_owner` once the turn ended |
| The key | an owner minted under it exits 5; the broker refuses a token with `invalid_authorization` | see 5.4 |

## 11. Post-incident checklist

- [ ] The incident has a Kanbus issue; the break-glass policy name, `T`, and who put it are in a comment (no account ids, no
      secrets, no tokens).
- [ ] The deny is removed (section 7) and `list-role-policies` shows only the CDK policies.
- [ ] Every suspended organization is reinstated and the members were told.
- [ ] The leaked credential's source is found and closed (a log that printed it, a dump, an overly broad `GetSecretValue`,
      a shared terminal). A token in a log is also a lesson for the log line: none of the owner log lines carries a token, a
      key or a credential by design (renewal contract section 13), so find what did.
- [ ] CloudTrail was reconciled with the broker log (9.3); the first and last `AssumeRole` for each affected owner are written
      down; after 2b, the span is the reachable window.
- [ ] The Front Door file audit records of every affected tenant were read for the window (9.1), and the ledger rows (9.2)
      for unexplained model spend; anything found is reported to the organization's owner.
- [ ] If the key was rotated, `AWSPREVIOUS` is gone and `GetSecretValue` on the secret is limited to the Front Door,
      the ComputerStarter and the broker (`aws iam` review of who else can read it).
- [ ] Unpublished work lost by stopped computers was listed per tenant and the owners told.
- [ ] A live computer turn works (10.1) and the revoked credential is dead (10.2).
- [ ] The follow-ups are Kanbus issues: the CDK switch for the deny (3.1), a signing-key rotation script with an
      `AWSPREVIOUS` overlap if that can be designed (the verifier would accept two keys for a while), an operator route to stop a
      computer, S3 data events on the snapshot bucket if the audit gap in 9.1 hurt, and a Logs Insights saved query set for the
      owner lines of section 1.2.
- [ ] This runbook was corrected for everything that surprised you, and the list in section 12 is shorter.

## 12. UNVERIFIED, and how to verify each

| # | What | How an operator verifies it |
| --- | --- | --- |
| U1 | The session-revoking deny does not stop the broker from issuing new sessions of the roles | 3.4 step 4, on a quiet moment on development, or: put the deny with `T` = now on development, cause one issue, look for `owner_broker_issued` after `T` and `delete-role-policy` |
| U2 | A hand-attached inline policy survives a CDK deploy of the ControlPlane stack | After the next deploy, `aws iam list-role-policies` still lists `AWSRevokeOlderSessions` (or does not) |
| U3 | A `update-function-configuration` description change recycles warm execution environments of the three functions | 5.4: a new `INIT_START` in each log group after the update, and a token minted under the old key being refused |
| U4 | The Front Door and the ComputerStarter keep the signing key for the container's lifetime | read `front-door.ts` (`composed` is a module variable) and `computer-starter.ts`; confirmed by U3 behaviour |
| U5 | Staging and production: they have no owner path today, so none of this applies, and the commands use development names | Check `aws secretsmanager list-secrets` for a `ModelGatewaySigningKey...` secret in the environment before using any command here |
| U6 | The exact message members see when a turn dies because the key rotated or the owner was lost, and the cold start time | Do the rotation drill on development (5.2) with a member turn in flight, and read the web app |
| U7 | The shape of the `AssumeRole` row on a real match, and the populated-tenant audit query projection | Run the commands of 9.1 and 9.3 after any normal computer turn on development |
| U8 | Whether `bin/acceptance.ts` exercises a computer turn | read it, or use 10.1 step 2 |
| U9 | Whether a 401 for a bad signature precedes body validation on `/host/owner/poll` | present a leaked token with a valid body shape (a fixture from `host-protocol/src/supervisor.ts`) |
| U10 | S3 and DynamoDB data events in staging and production | `aws cloudtrail describe-trails` and `get-event-selectors` in each account |
| U11 | The reach and timing of every "after 2b" statement | re-read this page when 2b lands (the first `supervisor_renewal` in `conversation/src`) |
| U12 | The commands of 1.2 (`logs start-query` text, ECS tag query with `--include TAGS`) beyond what was run | run them once on development on a quiet day; the lookup of roles, the function configuration reads, the simulator, `simulate-role-access.ts`, the DynamoDB query shape, `lookup-events`, `list-secret-version-ids`, and `logs start-query` were run |
| U13 | A second reader following this page once (ticket chatticus-816a1a acceptance) | open: a second operator runs sections 1, 3.3, 5.1 and 9 on development read-only and comments on the ticket |

Related: [Owner credential renewal](OWNER_CREDENTIAL_RENEWAL.md) 12.1 to 12.3, [Owner supervisor protocol](OWNER_SUPERVISOR_PROTOCOL.md)
section 7 (the broker), [AWS authentication](AWS_AUTH.md) (invoke key rotation, no minted keys),
[Role access guard](ROLE_ACCESS_GUARD.md), [Live files protocol](LIVE_FILES_PROTOCOL.md) (the audit), [Operator organization
seed](OPERATOR_ORG_SEED.md) (suspend and reinstate), [Threat model](THREAT_MODEL.md).
