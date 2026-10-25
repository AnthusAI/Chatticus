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
- Everything is written for **development**: profile `chatticus-production`, because one AWS account holds all three
  environments, and stack `ChatticusControlPlaneDevelopment`. The stacks of the other two environments carry the suffixes
  `Staging` and `Production`, and **production's own stacks have no suffix at all** (`ChatticusComputers`, not
  `ChatticusComputersProduction`). A name that matches "by prefix" can therefore match production while you meant development;
  the shell setup in 0.1 selects every name exactly, and every command below uses those variables. Do not retype a name.
- Staging and production have no owner path yet: the signing key parameter is created in the development ControlPlane stack only
  (`control-plane-stack.ts`: `if (isDevelopment)`), there is no broker in the staging or production ControlPlane stack, and
  `aws ssm describe-parameters --parameter-filters Key=Name,Values=/chatticus/staging/model-gateway/signing-key` (and the
  production name) finds nothing. When they get one, the commands change by the stack suffix and by the variables in 0.1.
- **The generated keys live in SSM Parameter Store, not Secrets Manager.** The signing key and the operator key are standard
  SecureStrings under the default `aws/ssm` key, created once by infrastructure code (`infra/lib/generated-secure-string.ts`).
  SSM has no `AWSPREVIOUS` stage and keeps up to 100 old versions of a parameter readable by anyone with
  `ssm:GetParameterHistory` or a `name:version` read. So a key is never "rotated in place" on this page: it is **recreated**
  (delete the parameter, which drops every version, then put a new one). No role in the stack holds `GetParameterHistory` on
  either parameter, and the role access manifest (`deniedRows`) and its post-deploy simulation check that the per-turn and
  supervisor roles are denied every read of both.
- Anything this page could not verify is marked **UNVERIFIED**, with the way to verify it. Section 12 lists them.

## 0. What exists, in one table

| Thing | Name | Where it lives | Lifetime | Who may use it |
| --- | --- | --- | --- | --- |
| Supervisor role | `ComputerSupervisorRole` (CDK construct id; the physical name is generated, `ChatticusControlPlaneDeve-ComputerSupervisorRoleE30-<suffix>`, and changes when the stack is recreated) | `infra/lib/computer-host-start.ts` | sessions of at most 3600 s | only the broker's execution role may assume it, with exactly two session tags |
| Per-turn role | `ComputerOwnerScopedRole` (same pattern) | the same file | sessions of at most 3600 s | only the broker, with exactly five session tags |
| Credential broker | Lambda with logical id `OwnerCredentialBroker...` (physical name `ChatticusControlPlaneDeve-OwnerCredentialBroker9BE-<suffix>`, its log group is `/aws/lambda/<physical name>`) | `conversation/src/lambdas/owner-credential-broker.ts` | | invoked by the Front Door only |
| Signing key | SSM SecureString `/chatticus/development/model-gateway/signing-key` (CDK construct id `ModelGatewaySigningKeyParameter`); its name is in `CHATTICUS_MODEL_GATEWAY_SIGNING_KEY_PARAMETER_NAME` on the Front Door, the ComputerStarter and the broker, each with `ssm:GetParameter` on that exact ARN | `infra/lib/control-plane-stack.ts` | until recreated | those three functions only |
| Bootstrap token | signed with the key; audience `owner-bootstrap` | minted by the ComputerStarter, held in the owner task's container override | 300 s, single use | the supervisor, once |
| Supervisor token | signed with the key; audience `computer-owner` | supervisor memory | 3600 s each, renewed about every 40 minutes for up to 8 hours | the owner routes of one computer |
| Model gateway token | signed with the key; audience `model-gateway` | supervisor memory, child over the socket | at most 3600 s | model calls of one turn |
| Invoke key | secret `InvokeKey...`, SSM `/chatticus/<environment>/thin-turn/invoke-key-secret-arn` | CloudFront origin header | until rotated | CloudFront, then the Front Door |
| Operator key | SSM SecureString `/chatticus/<environment>/thin-turn/operator-key` (CDK construct id `OperatorKeyParameter`, thin-turn stack); its name is in `CHATTICUS_OPERATOR_KEY_PARAMETER_NAME` on the Front Door, which holds `ssm:GetParameter` on that exact ARN | `infra/lib/thin-turn-stack.ts` | until recreated | `POST /operator/orgs/{tenant_id}/{enable,suspend,reinstate}` |
| Retired secrets | Secrets Manager `ModelGatewaySigningKey...` (development ControlPlane stack) and `OperatorKey...` (each thin-turn stack); no template references them any more | none (retained, orphaned) | until their scheduled deletion completes | nothing reads them; they hold the **old** values, so a leak of an old value is still a leak until the deletion window ends (30 days after scheduling) |

### 0.1 Set up the shell once (READ-ONLY)

Physical names carry a generated suffix and change whenever a stack is recreated, so nothing below hard-codes one. Run this
block first in the shell you will use for the whole incident. Each lookup picks the **development** resource by stack and
logical id, and the cluster lookup includes the slash and the suffixed stack name so that it cannot match production's
`ChatticusComputers-Cluster...` or staging's.

```sh
export AWS_PROFILE=chatticus-production AWS_REGION=us-east-1
STACK=ChatticusControlPlaneDevelopment
stack_resource() { aws cloudformation describe-stack-resources --stack-name "$STACK" --query "StackResources[?ResourceType=='$1' && starts_with(LogicalResourceId,'$2')].PhysicalResourceId | [0]" --output text; }
FRONT_DOOR=$(stack_resource AWS::Lambda::Function FrontDoor)
BROKER=$(stack_resource AWS::Lambda::Function OwnerCredentialBroker)
STARTER=$(stack_resource AWS::Lambda::Function ComputerStarter)
SUPERVISOR_ROLE=$(stack_resource AWS::IAM::Role ComputerSupervisorRole)
SCOPED_ROLE=$(stack_resource AWS::IAM::Role ComputerOwnerScopedRole)
CLUSTER=$(aws ecs list-clusters --query 'clusterArns[?contains(@, `/ChatticusComputersDevelopment-Cluster`)] | [0]' --output text)
COMPUTER_LOGS=$(aws cloudformation describe-stack-resources --stack-name ChatticusComputersDevelopment --query "StackResources[?ResourceType=='AWS::Logs::LogGroup'].PhysicalResourceId | [0]" --output text)
SIGNING_KEY_PARAMETER=$(aws lambda get-function-configuration --function-name "$FRONT_DOOR" --query Environment.Variables.CHATTICUS_MODEL_GATEWAY_SIGNING_KEY_PARAMETER_NAME --output text)
TABLE=$(aws lambda get-function-configuration --function-name "$FRONT_DOOR" --query Environment.Variables.CHATTICUS_MESSAGING_TABLE --output text)
BUCKET=$(aws lambda get-function-configuration --function-name "$FRONT_DOOR" --query Environment.Variables.CHATTICUS_SNAPSHOT_BUCKET --output text)
```

Check before you go on: every variable is non-empty and none says `None`; `echo "$CLUSTER"` contains `ChatticusComputersDevelopment`
(if it does not, **stop**: a `stop-task` against the wrong cluster stops another environment's computer); `echo "$COMPUTER_LOGS"`
starts with `ChatticusComputersDevelopment-ComputerLogs`. The owner task's log group (the supervisor's lines) is
`$COMPUTER_LOGS`, a group with no `/aws/lambda/` prefix; the Lambda log groups are `/aws/lambda/$FRONT_DOOR`,
`/aws/lambda/$BROKER` and `/aws/lambda/$STARTER`.

### What is live

Phase 2b (credential renewal) is live on development: `supervisor_renewal` is a broker purpose
(`conversation/src/lambdas/owner-credential-broker.ts`), the supervisor writes the `owner_credentials_refreshed` lines
(`computer/host/src/supervisor.ts`), and the minimum owner protocol version is 3. The facts this page relies on:

- Every supervisor credential, per-turn credential and token lasts at most 3600 s. The supervisor renews its own credentials
  1200 s before they end (about 40 minutes after they were issued) and keeps renewing for as long as the owner stays the live
  owner, up to the hard end of 8 hours (28800 s, `OWNER_HARD_LIFETIME_SECONDS`, decision S4). A stolen supervisor token is
  therefore usable for as long as the owner lives, up to 8 hours, not one hour (12.2 of the renewal contract).
- A session-revoking deny on a role (section 3) leaves every live owner without AWS access until its **next scheduled renewal**,
  at most about 40 minutes, and then it continues on a new session with a later issue time. Nothing triggers an early renewal:
  the supervisor does not renew because a request failed. This is longer than 12.3 of the renewal contract says ("one failed
  request"); the code is what this page follows.

## 1. Triage: what leaked, whose, since when

Do these in order. All are READ-ONLY. They take about five minutes. Do not skip to containment when the leak is clearly
live (an attacker is acting): go to section 2 first, then come back.

### 1.1 Which kind of credential

| It looks like | It is | Go to the decision table row |
| --- | --- | --- |
| An access key id starting `ASIA`, a secret key and a session token, in a log, a ticket or a paste | an AWS role session (supervisor or per-turn). `aws sts get-caller-identity` with it names the role and the session name (see below) | A or B |
| A string `ct1.<claims>.<signature>` (two dot-separated parts after the `ct1.` marker), used as `Authorization: Bearer` | a token (bootstrap, supervisor or model gateway); the claims are base64url JSON in the first part, never decode it into a ticket | C, D or E |
| The value of the parameter `/chatticus/development/model-gateway/signing-key`, or a way to read it (`ssm:GetParameter` or `ssm:GetParameterHistory` on it, a log line that contains it, a Lambda environment dump; also the value of the retired `ModelGatewaySigningKey...` secret, which is the previous key) | the signing key | F |
| The CloudFront invoke key, the operator key | not part of the owner path | G |

To tell the role of an AWS credential without acting as it (this uses the leaked credential once, only to ask who it is;
read it from a protected file, not from the command line):

```sh
sh -c 'set -a; . "$LEAKED_CREDENTIALS_FILE"; set +a; aws sts get-caller-identity --query Arn --output text' | sed -E 's/[0-9]{12}/************/g'
```

The result `arn:aws:sts::...:assumed-role/ChatticusControlPlaneDeve-ComputerSupervisorRole.../supervisor-<ownerId>` is a
supervisor session; `.../ComputerOwnerScopedRole.../turn-<ownerId>` is a per-turn session. The part after the last slash is
`supervisor-` or `turn-` followed by the owner id (decision R20 of the renewal contract; the broker names the session the
same way, `OWNER_SUPERVISOR_PROTOCOL.md` section 7, and a renewed session keeps the name). If the file is not a credential of those two roles, this runbook does not
apply to it.

### 1.2 Which tenant, computer, owner and turn

The owner id in the session name is the key. Every owner log line carries `tenant_id` and `owner_id`; log lines are one line
per event, `event key=value key=value` (`conversation/src/observability/log-line.ts`).

```sh
NOW=$(date +%s)
aws logs start-query \
  --log-group-name "/aws/lambda/$BROKER" \
  --start-time $((NOW - 7200)) --end-time "$NOW" \
  --query-string 'fields @timestamp, @message | filter @message like /owner-OWNER_ID_HERE/ | sort @timestamp asc | limit 50' \
  --query queryId --output text
aws logs get-query-results --query-id QUERY_ID_FROM_ABOVE --query 'results[][?field==`@message`].value[]' --output text
```

(`logs start-query` writes nothing; it is read-only. The query runs for a few seconds: `get-query-results` reports `Running`
until it is `Complete`. Repeat it with `--log-group-name "/aws/lambda/$FRONT_DOOR"`, `"/aws/lambda/$STARTER"` and
`"$COMPUTER_LOGS"`: the broker, the Front Door, the starter and the supervisor each write different lines, see the table below.
A group that was never written to answers `Complete` with no rows. List the groups with
`aws logs describe-log-groups --log-group-name-prefix /aws/lambda/ChatticusControlPlaneDeve --query 'logGroups[].logGroupName' --output text`;
the prefix is deliberately short, because a physical name is cut to fit 64 characters and the starter and the broker lose
the end of `Development` to the cut.)

The owner log lines that exist today, and what each tells you:

| Line | Written by | Tells you |
| --- | --- | --- |
| `owner_token_minted`, `owner_task_started` | ComputerStarter | a bootstrap token was minted for this owner, the task ARN, the start generation |
| `owner_broker_issued` (`purpose=supervisor`, `supervisor_renewal` or `turn`, `tenant_id`, `owner_id`, `turn_id`) | broker | credentials were issued: when, for which owner, for which turn |
| `owner_broker_refused` (`code=invalid_authorization`, `authorization_mismatch`, `unsafe_tag_value`, `assume_role_failed`, `signing_key_unavailable`, `invalid_request`) | broker | an attempt that failed. A burst of `invalid_authorization` is someone presenting tokens signed with another key, or expired ones |
| `owner_bootstrap_ok`, `owner_bootstrap_refused` | Front Door | the bootstrap exchange; a refused one names a code |
| `owner_stop_decision`, `owner_stopping`, `owner_poll_failed` | Front Door, supervisor | how the owner ended; `owner_poll_failed status=401` is a token the server stopped accepting |
| `component: "model-gateway"` lines (JSON) with `reason` | Front Door | a gateway token refused: `tampered`, `wrong_audience`, `wrong_owner`, `finished_turn`, `wrong_turn`, `organization_mismatch` |

The renewal lines of section 13 of the renewal contract are live. The supervisor writes, to its log group (`$COMPUTER_LOGS`):
`owner_credentials_refreshed` (`kind=supervisor` or `turn`, `expires_at`, `attempts`), `owner_credentials_refresh_failed`,
`owner_credentials_refresh_refused`, `owner_draining` and `owner_stopping`. The broker writes `owner_broker_issued` with
`purpose=supervisor`, `supervisor_renewal` or `turn`. An owner that lived two hours therefore has one `purpose=supervisor`, two
`purpose=supervisor_renewal` (at about 40 and 80 minutes) and one `purpose=turn` per turn it served. A line that does not fit
that count is the thing to explain.

Which computer and which task: the task carries tags (`hostTaskTags`, `conversation/src/computer/host-starter.ts`). With the
tenant id from the owner log lines:

```sh
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

There is **no operator route that stops a computer or marks it stopped, and no per-computer disable flag**
(story `chatticus-ebf08a`). The routes that
exist are the three below. The route that sets `stopped` (`POST /orgs/{tenant_id}/host/computer/state`) takes a worker or owner
credential and is for the owner itself; do not call it as an operator.

Two ways, one implementation (`docs/OPERATOR_ORG_SEED.md`):

```sh
node conversation/bin/members.ts suspend TENANT_ID --yes
```

needs `CHATTICUS_MESSAGING_TABLE="$TABLE"` exported and AWS credentials for the environment (read it first, READ-ONLY:
`node conversation/bin/members.ts show TENANT_ID`, run from the repository root after `npm ci`); or the operator route, with the
operator bearer read from its SSM parameter into a protected stream (the bearer never touches the command line or the terminal):

```sh
BASE=$(aws ssm get-parameter --name /chatticus/development/thin-turn/cloudfront-url --query Parameter.Value --output text)
aws ssm get-parameter --name /chatticus/development/thin-turn/operator-key --with-decryption --query Parameter.Value --output text \
  | { read -r OPERATOR_KEY; printf 'header = "Authorization: Bearer %s"\n' "$OPERATOR_KEY" | curl -sS --config - -X POST "$BASE/operator/orgs/TENANT_ID/suspend" -o /dev/null -w '%{http_code}\n'; }
```

Expect `200`. The CloudFront invoke key is added by CloudFront itself on this path. (On development, a request with a wrong
bearer answers `403 operator credential required`, so the path and the gate are known good; the success path changes an
organization and was not run for this page.) **Cost:** every member of that organization
is refused until `reinstate`. **Undo:** the same command with `reinstate` (not `enable`, which accepts `pending` only).
Suspension does not stop an owner that is already running: the owner routes do not look at the organization status. That is
what 2.2 is for. **Do not suspend every organization to contain one tenant's leak.** Suspend only the tenants whose owner ids
appeared in triage.

### 2.2 Stop the owner task (DESTRUCTIVE for that tenant's running computer)

```sh
echo "$CLUSTER"
aws ecs stop-task --cluster "$CLUSTER" --task TASK_ARN_HERE --reason "credential leak, runbook OWNER_CREDENTIAL_REVOCATION"
```

Read the `echo` before the second line: the cluster name must contain `ChatticusComputersDevelopment`. Production's cluster is
`ChatticusComputers-Cluster...` and a task ARN from it stops a customer's computer. (Section 0.1 explains the selector.)

**Cost:** the computer loses everything it has not published to its snapshot: files written to its disk since the last
publish. The task gets SIGTERM and Fargate allows its stop timeout; the supervisor's SIGTERM path publishes if it can
(`SUPERVISOR_EXIT_SIGTERM`, exit 143), but do not count on it, and if the supervisor's S3 credentials are the leaked thing,
you would rather it did not. An approved edit that sits in the overlay is in S3 under the Front Door's control and survives.
**Who:** anyone with `ecs:StopTask` on the cluster (the operator profile). **Undo:** none for the task; the computer starts
again at the next member message, if the organization is enabled.

Step (1) of the renewal contract (17 R) says "the owner reports stopped". It does not: `stop-task` kills the container, and a
killed supervisor reports nothing. What happens is the lost-owner path below.

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
broker** (the policy shape is verified by the simulator, 3.3, and by CDK synthesis, 3.1, but no deny was attached to a live
role while writing or second-reading this page). Verify it with the check in 3.4.

### 3.1 The rule is a CDK change; the break-glass path is an exception

Decision S6 of the renewal contract (12.3, 17 R): the deny is **a CDK change deployed by the normal path, never by hand in the
console**. AGENTS.md says the same: AWS resources exist as CDK. That is the path to use whenever the leak is stale or
contained, because the deny then stays in the repository, is reviewed, and survives redeploys.

The change, in `wireComputerStarterOwnerRunTask` (`infra/lib/computer-host-start.ts`), after the two roles are created. It
adds one separate `AWS::IAM::Policy` per role, so the roles' own `Policies` stay empty and the removal later is a deletion of
two resources:

```ts
const ownerSessionsRevokedBefore: string | undefined = "2026-10-20T12:00:00Z";
if (ownerSessionsRevokedBefore !== undefined) {
  for (const role of [supervisorRole, scopedRole]) {
    new iam.Policy(stack, `${role.node.id}SessionsRevokedBefore`, {
      policyName: "OwnerSessionsRevokedBefore",
      roles: [role],
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          actions: ["*"],
          resources: ["*"],
          conditions: { DateLessThan: { "aws:TokenIssueTime": ownerSessionsRevokedBefore } },
        }),
      ],
    });
  }
}
```

Set the time to the current UTC time when you write the change, never later than the moment the deploy will finish (a time in
the future denies sessions the broker issues before it, see 3.2). Merging the
change to `develop` runs the workflow `Deploy ControlPlane (development)` (`.github/workflows/deploy-controlplane-development.yml`);
the fallback is `sh infra/deploy-chatticus-dedicated-account.sh development control-plane` from a logged-in shell. Both deploy only
the ControlPlane stack. This page does **not** run either: the deny was synthesized, never deployed (3.3).

**This is not built.** The snippet above is what an operator writes by hand today: there is no stack property, no CDK context
and no deploy-script switch for it, so a revocation needs a code change and a PR that takes tens of minutes (a green CI and a
deploy of the stack). Kanbus story `chatticus-c06de6` (the CDK switch for the session revocation deny) builds the switch. Until it lands, the live-leak case below uses the CLI.

| | CDK change, deployed by the normal path (the rule) | Break-glass `put-role-policy` (the exception) |
| --- | --- | --- |
| Source of truth | stays the repository | the live role only; invisible to CDK and to review |
| Time to effect | a PR, a green CI, a deploy of the ControlPlane stack: tens of minutes | seconds |
| Drift | none | an inline policy CloudFormation does not know. **UNVERIFIED:** CloudFormation does not remove an inline policy it did not create. In the synthesized template the roles carry no `Policies` property at all; their permissions are the separate `AWS::IAM::Policy` resources `ComputerSupervisorRoleDefaultPolicy...` and `ComputerOwnerScopedRoleDefaultPolicy...`. Verify with `aws iam list-role-policies` after the next deploy |
| When | the leak is stale or contained, and you want the deny to survive redeploys | the leak is live and every minute counts |

Break-glass is allowed here as a **recorded exception to S6 and to AGENTS.md**, with three conditions: it uses the CLI against
the environment's own profile (never the console, never a copied key), it is recorded in the incident Kanbus issue the moment it
is put (policy name, time `T`, who), and it is removed in section 7. It uses the policy name `AWSRevokeOlderSessions` (the name
the console's own "Revoke active sessions" uses); the CDK change uses `OwnerSessionsRevokedBefore`, so the two never collide and
each is removed by the path that created it. If you used break-glass, follow it with the CDK change in the same incident, so
that the repository again says what the roles do.

### 3.2 Put the break-glass deny (DESTRUCTIVE)

Set `T` to the current UTC time. Sessions issued before `T` are denied; sessions issued at or after `T` are not. Do not set
`T` in the future: a session the broker issues between now and `T` would be denied too, and the live system would fail until
`T` passes.

```sh
REVOKE_BEFORE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "$REVOKE_BEFORE" "$SUPERVISOR_ROLE" "$SCOPED_ROLE"
DENY_DOCUMENT=$(printf '{"Version":"2012-10-17","Statement":{"Effect":"Deny","Action":"*","Resource":"*","Condition":{"DateLessThan":{"aws:TokenIssueTime":"%s"}}}}' "$REVOKE_BEFORE")
aws iam put-role-policy --role-name "$SUPERVISOR_ROLE" --policy-name AWSRevokeOlderSessions --policy-document "$DENY_DOCUMENT"
aws iam put-role-policy --role-name "$SCOPED_ROLE" --policy-name AWSRevokeOlderSessions --policy-document "$DENY_DOCUMENT"
```

`SUPERVISOR_ROLE` and `SCOPED_ROLE` come from 0.1; read the `echo` before the two `put-role-policy` lines (two role names that
start `ChatticusControlPlaneDeve-ComputerSupervisorRole` and `...-ComputerOwnerScopedRole`). If a policy named
`AWSRevokeOlderSessions` exists (`aws iam list-role-policies --role-name "$SUPERVISOR_ROLE"`), the command replaces it, which
moves `T` forward and is what you want. Put both policies in one go; a half-revoked pair leaves the other role's leaked sessions
alive.

**Cost:** every live supervisor and every live turn in the environment loses its AWS access at once: S3 snapshot publishes
and Pi session and conversation writes fail with `AccessDenied`.
Each owner is impaired until its next scheduled renewal (up to about 40 minutes, since renewal starts 1200 s before a 3600 s
session ends; nothing renews early because a request failed), then continues on a new session. Publishes and turn writes in the
gap fail and are retried. An owner that cannot recover in time (a publish that must finish, a turn that times out) ends the way
a lost owner ends (2.2) and the computer restarts at the next message from its last published snapshot, losing the unpublished
disk state.

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
SUPERVISOR_ARN=$(aws lambda get-function-configuration --function-name "$BROKER" --query Environment.Variables.CHATTICUS_OWNER_SUPERVISOR_ROLE_ARN --output text)
for ISSUED in 2026-10-14T02:00:00Z 2026-10-14T04:00:00Z; do
  aws iam simulate-principal-policy --policy-source-arn "$SUPERVISOR_ARN" --policy-input-list "$DENY_DOCUMENT" \
    --action-names s3:GetObject --resource-arns "arn:aws:s3:::$BUCKET/tenants/t1/computers/c1/x" \
    --context-entries ContextKeyName=aws:TokenIssueTime,ContextKeyValues=$ISSUED,ContextKeyType=date \
      ContextKeyName=aws:PrincipalTag/tenant,ContextKeyValues=t1,ContextKeyType=string \
      ContextKeyName=aws:PrincipalTag/computer,ContextKeyValues=c1,ContextKeyType=string \
    --query 'EvaluationResults[].EvalDecision' --output text
done
```

With a deny whose `T` is `2026-10-14T03:00:00Z`, the session issued at `02:00` prints `explicitDeny` and the one issued at
`04:00` prints `allowed`; the same question with no extra policy printed `allowed` for the old session. That is the whole
claim of the technique, checked against the real role: old sessions denied, new sessions untouched. It was run on
development when this page was written and again, as written, by the second reader on 2026-10-20 (same two answers). Run it
against the owner per-turn role the same way with an action from its policy (`conversation/src/gateway/owner-role-policy.json`).

The CDK change of 3.1 is checked the same way, by synthesis, which writes only to a local directory and deploys nothing. Make
the edit of 3.1 in a scratch worktree (never on `develop`), then:

```sh
cd infra
npx cdk synth ChatticusControlPlaneDevelopment --exclusively --quiet --output "$SYNTH_DIRECTORY" -c chatticusAccountEnvironment=development
jq '.Resources | to_entries[] | select(.key | test("SessionsRevokedBefore")) | {logicalId: .key, policy: .value.Properties.PolicyName, roles: .value.Properties.Roles, statement: .value.Properties.PolicyDocument.Statement}' "$SYNTH_DIRECTORY/ChatticusControlPlaneDevelopment.template.json"
git checkout infra/cdk.context.json
```

(`npm ci` first in a fresh worktree; synthesis bundles the Lambdas and needs the `conversation` dependencies. The `git checkout`
puts back the context file that synthesis may rewrite; never commit that file with an incident change.) Expect exactly two
policies, `ComputerSupervisorRoleSessionsRevokedBefore...` and `ComputerOwnerScopedRoleSessionsRevokedBefore...`, each with one
statement `Effect` `Deny`, `Action` `*`, `Resource` `*`, `Condition` `DateLessThan` of `aws:TokenIssueTime` at your `T`, and
`Roles` a reference to the matching role. This was synthesized by the second reader on development; it was **not deployed**.

### 3.4 Prove the deny works on the live roles after step 3.2 (READ-ONLY)

1. The policy is present, and its time is the one you intended (`AWSRevokeOlderSessions` for the break-glass path,
   `OwnerSessionsRevokedBefore` for the CDK change). Before any deny exists, both commands answer `NoSuchEntity`, which is how
   the second reader confirmed development carried none:
   ```sh
   aws iam get-role-policy --role-name "$SUPERVISOR_ROLE" --policy-name AWSRevokeOlderSessions --query PolicyDocument --output json
   aws iam get-role-policy --role-name "$SCOPED_ROLE" --policy-name AWSRevokeOlderSessions --query PolicyDocument --output json
   aws iam list-role-policies --role-name "$SUPERVISOR_ROLE" --output text
   aws iam list-role-policies --role-name "$SCOPED_ROLE" --output text
   ```
2. The manifest check still passes. `conversation/bin/simulate-role-access.ts` puts the 42 request shapes of the role access
   manifest to the simulator **without** an issue time, so a `aws:TokenIssueTime` deny does not match them and every case still
   reads allowed (reasoned from how the simulator treats an absent condition key; **UNVERIFIED** with a live attached deny). That is the expected result and it is what the check is for here: it proves the roles' own permissions did
   not change. It does not prove the deny.
   ```sh
   cd conversation && npx tsx bin/simulate-role-access.ts --environment development
   ```
   Expect `PASS role access development: 42 of 42 allowed (frontDoor 12, ownerTurn 28, supervisor 2)`. (Run read-only on
   development while writing this page and again by the second reader, before any deny existed.) If the SDK complains the SSO token is expired although the
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
| Supervisor token (audience `computer-owner`) | stop the owner (2.2). The token names an owner id and a generation; once the owner is not the live owner of the current generation every owner route answers 403 (`not_current_owner`, `stale_generation`). The same refusal ends renewal. The window until then is the token's own expiry, at most an hour, and a renewed token lives only as long as the owner does (decision S4: up to 8 hours) |
| Model gateway token (audience `model-gateway`) | end the turn. The gateway refuses a token whose turn is not `active` (`finished_turn`) or not claimed by the token's owner (`wrong_owner`) (`conversation/src/gateway/model-gateway.ts`). Stop the owner (2.2): the turn is parked or failed and the claim moves. No operator route fails a single turn |

If you must kill every token of every kind at once, or the key is what leaked, the only lever is section 5.

## 5. Rotate the signing key (DESTRUCTIVE, global, the last resort)

The key signs all three token kinds. Anyone holding it can mint a bootstrap token for any tenant and have the broker turn it
into supervisor credentials, or mint a supervisor token or a gateway token directly. Revoking sessions and stopping tasks do
not help against a leaked key, because the attacker mints new tokens. Rotate the key first, then revoke sessions (section 3) to
kill whatever the forged tokens already obtained.

**There is no signing-key rotation script** (story `chatticus-541dc7`). `infra/rotate-invoke-key.sh` rotates the invoke key only (section 6). The
signing key has no `AWSPREVIOUS` fallback, and neither does an SSM parameter: the Front Door, the ComputerStarter and the broker each read one
parameter value and verify and sign with it, so unlike the invoke key there is no overlap window, and a rotation invalidates every token at
once. The key is **recreated**, not overwritten: an overwrite would leave the old value readable as version 1 by name and version (and through
`GetParameterHistory`) for as long as SSM keeps it, and the old value is the leaked one. The steps below are manual.

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
aws ssm describe-parameters --parameter-filters "Key=Name,Values=$SIGNING_KEY_PARAMETER" --query 'Parameters[].[Name,Version,Type,Tier]' --output text
```

(READ-ONLY; `SIGNING_KEY_PARAMETER` is set in 0.1. `describe-parameters` never returns the value. Note the version: after step 1 it is `1`
again, because the parameter is a new one. Expect `SecureString` and `Standard`.)

1. Recreate the parameter with a new value. 64 characters of letters and digits is what the stack generates (`MODEL_GATEWAY_SIGNING_KEY_LENGTH`; the
   code refuses a key under 32). The value never appears on a command line or in the terminal. Use `printf '%s'`, not `echo` and not a
   pipe straight from a command that ends its output with a newline, because every reader takes the parameter verbatim and a newline
   would become part of the key. Deleting the parameter drops every version, which is what retires the leaked value; between the two
   commands the readers see `ParameterNotFound` and the ComputerStarter and the broker refuse, which is acceptable because step 5
   stops every owner anyway. Do not use `--overwrite`:
   ```sh
   aws ssm delete-parameter --name "$SIGNING_KEY_PARAMETER"
   NEW_VALUE=$(openssl rand -base64 96 | tr -dc 'A-Za-z0-9' | head -c 64)
   printf '%s' "$NEW_VALUE" | aws ssm put-parameter --name "$SIGNING_KEY_PARAMETER" --type SecureString --tier Standard --no-overwrite --value file:///dev/stdin --query Version --output text
   NEW_VALUE=
   ```
   The CloudFormation custom resource that first created the parameter is retained and does nothing on later deploys (Update and Delete are
   no-ops), so a deploy never touches the recreated parameter.
2. Make the three readers re-read it. The Front Door and the ComputerStarter read the parameter once when their code first
   composes in a container (`front-door-composition.ts`, `computer-starter.ts`), and keep it for the life of the container, so
   a warm container keeps the old key for hours. The broker caches it for 300 s (`BROKER_SIGNING_KEY_CACHE_SECONDS`). A
   configuration change makes new invocations start new execution environments, which re-read the parameter. Change the
   description to a timestamp (the one setting nothing depends on):
   ```sh
   for FUNCTION in "$FRONT_DOOR" "$STARTER" "$BROKER"; do
     aws lambda update-function-configuration --function-name "$FUNCTION" --description "signing key rotated $(date -u +%Y-%m-%dT%H:%M:%SZ)" --query LastUpdateStatus --output text
     aws lambda wait function-updated-v2 --function-name "$FUNCTION"
   done
   ```
   That a description change recycles warm execution environments is how Lambda treats any configuration update;
   it is **UNVERIFIED** on this deployment. Verify as in 5.4. The next normal deploy resets the description (harmless drift).
   Updating the configuration does not change the environment variables; never pass `--environment` here, it replaces them all.
3. Confirm no old version is left. The delete in step 1 removed them; if the leak was access to the parameter itself, also fix who has
   `ssm:GetParameter`, `ssm:GetParameters` and above all `ssm:GetParameterHistory` on it (section 11): only the Front Door, the
   ComputerStarter and the broker may read it, and nothing may read its history.
4. Revoke the sessions (section 3). Tokens signed with the leaked key may already have been exchanged for AWS credentials; the
   deny ends them. Use the time `T` of the moment after step 2 completed.
5. Stop every running owner task (2.2) rather than waiting for their 401: they would exit by themselves within one poll
   interval, but a stopped task is certain. List them all with `aws ecs list-tasks --cluster "$CLUSTER" --desired-status RUNNING`.

**Who:** the operator profile with `ssm:DeleteParameter`, `ssm:PutParameter` and `lambda:UpdateFunctionConfiguration`.
**Undo:** none that is useful. Putting the old value back re-validates every token minted under it, including a forged one;
never do it.

### 5.3 How fast it takes effect

- The broker: at most 300 s (cache), or immediately after step 2.
- The Front Door and the ComputerStarter: only after step 2. Without step 2 a warm container keeps accepting old tokens, and
  minting new ones with the old key, indefinitely.
- Tokens already issued and not yet presented are dead on first use after the reader has the new key. There is no grace.

### 5.4 Verify the key is rotated (READ-ONLY)

- The parameter is a new one at version 1 and has no other version:
  `aws ssm describe-parameters --parameter-filters "Key=Name,Values=$SIGNING_KEY_PARAMETER" --query 'Parameters[].[Version,LastModifiedDate]' --output text`
  (the value is never shown). SSM has no `AWSPREVIOUS`, so there is nothing to retire.
- The functions are new: each shows a new `Last modified` (`aws lambda get-function-configuration --function-name F --query '[LastModified,Description,LastUpdateStatus]' --output text`),
  and the first invocation after that logs an `INIT_START` / `Init Duration` in its log group (a cold start).
- An old token is dead. The honest proof without minting a token: the owners' own behaviour. For every owner task you stopped or
  that was running, `owner_poll_failed status=401` in the Front Door's logs, and the ECS task's container exit code is 5:
  `aws ecs describe-tasks --cluster "$CLUSTER" --tasks TASK_ARN --query 'tasks[].containers[].exitCode' --output text`.
  And no `owner_broker_issued` for those owner ids after the rotation time. If you hold the leaked token itself (from the
  incident evidence), present it once to an owner route and expect 401:
  `BASE=$(aws ssm get-parameter --name /chatticus/development/thin-turn/cloudfront-url --query Parameter.Value --output text)` and
  `printf 'header = "Authorization: Bearer %s"\n' "$(cat LEAKED_TOKEN_FILE)" | curl -sS --config - -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/orgs/TENANT_ID/host/owner/poll" -w '\n%{http_code}\n'`.
  The token is checked before the body, so an empty body is enough (`owner-host-auth.ts`; the scenario "signed with another
  key" of `features/computer_owner_credential_renewal_route.feature` expects 401 `invalid_credential`). Run on development
  with a made-up token of the right shape (`ct1.` and two dummy parts, not a real secret): `401` with
  `{"detail":"invalid owner credential","code":"invalid_credential"}`, so the command is known good. Present a real leaked
  token only **after** the rotation or after the owner is gone: while that owner is still live, a poll with its token is the
  owner's heartbeat and can take work, so the probe itself would act as the thief. Afterwards it answers 401 (key rotated) or
  403 `not_current_owner` / `stale_generation` (owner gone).

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

(Run by the second reader on development: five `ok:` checks on CloudFront, the Function URL and the origin header, a list of the
steps it would take, and nothing written. The redeploy step it names is `gh workflow run 'Deploy Web (development)'`, so the
shell needs an authenticated `gh`.)

Then DESTRUCTIVE (several minutes: it waits 65 s twice and waits for a CloudFront deployment):

```sh
sh rotate-invoke-key.sh development --yes
```

It does not touch the owner path: owner routes and the model gateway are authenticated by their tokens, not by the invoke
key. If it stops halfway, `--resume --yes` finishes. If it is suspected leaked, do not stop between "put" and "retire"
(AWS_AUTH.md, "The window").

**Operator key** (`/chatticus/<environment>/thin-turn/operator-key`): a leaked key lets someone suspend or reinstate organizations. There is no
rotation script; the manual shape is the signing key's section 5.2 without the sessions and the owners: recreate the parameter
(`delete-parameter`, then `put-parameter --type SecureString --tier Standard --no-overwrite --value file:///dev/stdin` fed by `printf '%s'`;
never `--overwrite`, which leaves the leaked value readable as version 1), then force the Front Door to re-read it as in 5.2 step 2 (it reads
the key at composition, `front-door-composition.ts`). Only a human operator uses this key, so nothing else stops. SSM has no `AWSPREVIOUS`,
so there is no overlap window: the old key stops working when the Front Door re-reads.

## 7. After containment: remove the deny

Only after the leaked credential has expired on its own (one hour after the **latest** issue of anything that could have been
stolen) and the incident is understood. Removing the deny never revives a session issued before `T` for long (it expires on its
own within the hour), but it does let any session issued after `T` act. If a credential leaked again after `T`, do not remove
the deny: put a new, later `T` (section 3.2 replaces the policy).

Remove it by the path that put it. A deny that came from the CDK change (3.1) is removed by reverting that change and deploying
the ControlPlane stack the same way; its policy name is `OwnerSessionsRevokedBefore` and CloudFormation deletes the two
resources. A break-glass deny (3.2) is removed with the CLI:

```sh
aws iam delete-role-policy --role-name "$SUPERVISOR_ROLE" --policy-name AWSRevokeOlderSessions
aws iam delete-role-policy --role-name "$SCOPED_ROLE" --policy-name AWSRevokeOlderSessions
aws iam list-role-policies --role-name "$SUPERVISOR_ROLE" --output text
aws iam list-role-policies --role-name "$SCOPED_ROLE" --output text
```

(The first two are DESTRUCTIVE only in that they lift the protection; the last two are READ-ONLY, and the second reader ran
them on development.) After either removal each role should list only
its CDK policy, `ComputerSupervisorRoleDefaultPolicy...` and `ComputerOwnerScopedRoleDefaultPolicy...`. Also reinstate any
organization you suspended (2.1) once its computer is safe to start again.

## 8. Decision table

Cheapest sufficient action first. "Then" means in this order.

| # | What leaked | Others affected | Do | Cost | Who |
| --- | --- | --- | --- | --- | --- |
| A | One **supervisor AWS credential** (the `supervisor-<ownerId>` session) | the reach is one computer's snapshot prefix, not the overlay (an explicit deny), nothing in DynamoDB or STS | 2.1 suspend the tenant, then 2.2 stop its task. If the credential is under an hour old and you cannot wait for it to expire: section 3 for both roles (3.2 if it is live) | one tenant down; with section 3 every tenant's owners lose access | operator |
| B | One **per-turn AWS credential** (`turn-<ownerId>`) | one conversation's Pi session and items | 2.2 stop the task, which fails or parks the turn. section 3 if under an hour old and the content is sensitive | as A | operator |
| C | One **supervisor token** (no AWS keys) | owner routes of one computer; poll as the owner and obtain per-turn credentials for parked turns | 2.2 stop the task (the token is refused at once because the owner is no longer live). Then section 3 if credentials may already have been obtained (look for unexplained `owner_broker_issued` lines with `purpose=turn` or `supervisor_renewal` for that owner in triage: a stolen token renews the supervisor credentials while the owner is live) | one tenant restarts | operator |
| D | One **model gateway token** | model calls of one turn | end the turn; if you cannot, 2.2 | one turn lost | operator |
| E | A **bootstrap token** before use | one owner start | 2.2 stop that task; the generation moves on | one start retried | operator |
| F | The **signing key** (or the right to read the parameter or its history) | everything: any token for any tenant | section 5 steps 1 to 5 (recreate the parameter, make the functions re-read, confirm no old version, revoke sessions, stop all owners) | every owner stops, unpublished work is lost, every turn in flight fails | operator with `ssm:DeleteParameter` and `ssm:PutParameter` |
| G | The **invoke key** | bypass of CloudFront on non-owner routes | `rotate-invoke-key.sh` (section 6) | minutes; customer host workers (staging, production) need a restart | operator |
| H | **Unknown** which credential, but a session is acting from outside the task | possibly several | section 3 (both roles; 3.2 if it cannot wait for a deploy) immediately, then triage with the CloudTrail queries (9.3) while the sessions die; escalate to F if `AssumeRole` calls come from a principal other than the broker | environment-wide owner interruption | operator |
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
FROM_MS=$(( ($(date +%s) - 86400) * 1000 ))
aws dynamodb query --table-name "$TABLE" \
  --key-condition-expression 'pk = :pk AND sk >= :from' \
  --expression-attribute-values "{\":pk\":{\"S\":\"TENANT_ID#computer#audit\"},\":from\":{\"S\":\"at#$(printf '%013d' "$FROM_MS")\"}}" \
  --projection-expression '#at, user_id, owner_id, operation, #p, outcome, flags' \
  --expression-attribute-names '{"#at":"at","#p":"path"}' --output json
```

(`TABLE` is set in 0.1. The query was run as written on development with a tenant that has no audit rows and answered
`"Items": []`, `"Count": 0`; the projection and the attribute names are **UNVERIFIED** against a populated tenant.)

Limit: this trail records what went **through the Front Door**. A stolen supervisor credential talks to S3 directly, so what
it did to the snapshot prefix is **not** in this trail. A stolen per-turn credential talks to DynamoDB and the Pi sessions
bucket directly, likewise.

### 9.2 Ledger rows (what the model gateway forwarded)

Every model call the gateway forwarded is kept as an observation: partition `<tenant_id>#cost#observed`, sort key
`turn#<turn_id>#call#<call_id>`, with `owner_id`, model and token counts, kept 35 days
(`conversation/src/ledger/gateway-observation.ts`). Use it to see what a leaked gateway token or a forged one spent.

```sh
aws dynamodb query --table-name "$TABLE" --key-condition-expression 'pk = :pk' \
  --expression-attribute-values '{":pk":{"S":"TENANT_ID#cost#observed"}}' --select COUNT --query Count --output text
```

Drop `--select COUNT` and add a `--projection-expression` for the rows. Compare the owner ids and turns with the legitimate
ones from triage; a call whose `owner_id` was not the claimant at the time is the gateway's refusal case and should not exist
(the gateway checks that the turn is active and claimed by the token's owner).

### 9.3 CloudTrail (who obtained credentials, and what changed)

Management events are the only ones recorded, and they are recorded in two places. The 90 day Event history
(`lookup-events`) always exists. From 2026-10-20, the day the `ChatticusAuditTrail` stack was deployed (production stack set; `sh
infra/deploy-chatticus-dedicated-account.sh production audit-trail`) one multi-region trail, `chatticus-audit-trail`, also
delivers management events, reads and writes, global services such as IAM and STS included, to a private S3 bucket for 400
days. Before that day there is no trail and only the Event history exists: `aws cloudtrail describe-trails --query
'trailList[].Name' --output text` prints nothing until the stack is deployed (it printed nothing on 2026-10-20). The one
account holds development, staging and production, so the trail covers all three.

**S3 and DynamoDB data events are not recorded, by decision (cost).** CloudTrail can tell you who was issued a session, who
read a secret and what changed, never which snapshot objects or table items a session read. `GetSecretValue` and SSM `GetParameter` are management
events and are recorded.

Query the last 90 days with `aws cloudtrail lookup-events` (below). For older events, or to read in bulk, take the bucket from
the stack output (`aws cloudformation describe-stacks --stack-name ChatticusAuditTrail --query
'Stacks[0].Outputs[?OutputKey==`AuditTrailBucketName`].OutputValue' --output text`) and read
`s3://BUCKET/AWSLogs/ACCOUNT_ID/CloudTrail/REGION/YYYY/MM/DD/*.json.gz` (`aws s3 cp --recursive` for a day, then `zcat` and
`jq '.Records[] | select(.eventName == "AssumeRole")'`). Log file validation is on: `aws cloudtrail validate-logs --trail-arn
TRAIL_ARN --start-time TIME` proves the files were not altered.

Event names to look for:

| `eventName` | Why | Suspicious when |
| --- | --- | --- |
| `AssumeRole` on the two roles | a session was issued; `userIdentity.arn` is the caller, `requestParameters.roleSessionName` is `supervisor-<ownerId>` or `turn-<ownerId>` | the caller is not the broker's execution role (the trust policy forbids it, so this would mean the trust policy changed); a session name with an owner id the control plane never started; a burst |
| `GetParameter` (and `GetParameters`, `GetParameterHistory`) on the signing key or operator key parameter | who read a key; CloudTrail records the parameter name and never the value | any principal other than the Front Door, the ComputerStarter and the broker execution roles for the signing key, the Front Door for the operator key; any `GetParameterHistory` at all |
| `PutParameter`, `DeleteParameter`, `LabelParameterVersion` on those parameters | a key was created, recreated or relabelled | not you, not the creator Lambda on first deploy |
| `PutRolePolicy`, `AttachRolePolicy`, `UpdateAssumeRolePolicy`, `DeleteRolePolicy` on the two roles | the roles' permissions or trust changed | not the deploy role, not you |
| `UpdateFunctionConfiguration`, `UpdateFunctionCode` on the broker | its environment, including the role ARNs and the parameter name, changed | not the deploy role |
| `RunTask`, `StopTask` on the computers cluster | owner tasks | not the starter or you |

```sh
aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRole --max-results 50 \
  --query 'Events[].CloudTrailEvent' --output json \
  | jq -r '.[] | fromjson | select((.requestParameters.roleArn // "") | test("ComputerSupervisorRole|ComputerOwnerScopedRole")) | [.eventTime, .userIdentity.arn, .requestParameters.roleSessionName, .sourceIPAddress] | @tsv' \
  | sed -E 's/[0-9]{12}/************/g'
```

(Run on development as written, on 2026-10-20: the pipeline ran and printed no rows, because this development environment has
no owner log lines at all (it was recreated in this account on 2026-10-19); the printed row format is **UNVERIFIED** on a real match.) Repeat with
`--max-results 50` and the event names above; `lookup-events` returns 50 per call at most and only the last 90 days of
management events. A matching `AssumeRole` count per owner id against `owner_broker_issued` lines is the reconciliation: every
session must have a broker log line, and every broker line a session.

Add the `owner_credentials_refreshed` lines (the supervisor log group `$COMPUTER_LOGS`; `kind`, `expires_at`) and the broker's
`purpose=supervisor_renewal` lines: the reachable window of a stolen supervisor token is the span from the first to the last
`AssumeRole` for that owner id, at most 8 hours.

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
   `cd conversation && npx tsx bin/acceptance.ts --environment development`. It does **not** exercise a computer turn: its
   steps (`src/acceptance/smoke-test.ts`) post a message, steer a second one, read the turn's stream to `turn.completed` and
   reload the channel. It proves the front door, not the owner path, so step 2 is the proof that matters here.

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
- [ ] The leaked credential's source is found and closed (a log that printed it, a dump, an overly broad `ssm:GetParameter`,
      a shared terminal). A token in a log is also a lesson for the log line: none of the owner log lines carries a token, a
      key or a credential by design (renewal contract section 13), so find what did.
- [ ] CloudTrail was reconciled with the broker log (9.3); the first and last `AssumeRole` for each affected owner are written
      down; the span from the first to the last is the reachable window (at most 8 hours for a supervisor token).
- [ ] The Front Door file audit records of every affected tenant were read for the window (9.1), and the ledger rows (9.2)
      for unexplained model spend; anything found is reported to the organization's owner.
- [ ] If the key was recreated, the parameter is at version 1 and `ssm:GetParameter` on it is limited to the Front Door,
      the ComputerStarter and the broker (`aws iam` review of who else can read it), and no principal can call `GetParameterHistory`
      on it. The retired Secrets Manager secrets (section 0) are scheduled for deletion once the production deploy is verified, because they hold old key values.
- [ ] Unpublished work lost by stopped computers was listed per tenant and the owners told.
- [ ] A live computer turn works (10.1) and the revoked credential is dead (10.2).
- [ ] The follow-ups are Kanbus issues. Three exist and are the gaps of this runbook: the CDK switch for the deny
      (`chatticus-c06de6`, 3.1), the signing-key rotation script, written for SSM recreate semantics with no `AWSPREVIOUS` overlap (`chatticus-541dc7`, section 5),
      and an operator route to stop a computer (`chatticus-ebf08a`, 2.2). File the others the incident showed: S3 data events on
      the snapshot bucket if the audit gap in 9.1 hurt, and a Logs Insights saved query set for the owner lines of section 1.2.
- [ ] This runbook was corrected for everything that surprised you, and the list in section 12 is shorter.

## 12. UNVERIFIED, and how to verify each

The second reader (ticket `chatticus-816a1a`, 2026-10-20) followed sections 0 to 11 once on development, read-only, and
resolved or narrowed most of the earlier list. What is left, and what was resolved and by what:

| # | What | Status and how an operator verifies it |
| --- | --- | --- |
| U1 | The session-revoking deny does not stop the broker from issuing new sessions of the roles | Open. No deny was attached to a live role. 3.4 step 4 on a quiet moment on development, or the live proof of `chatticus-c06de6` |
| U2 | A hand-attached inline policy survives a CDK deploy of the ControlPlane stack | Open. The synthesized roles carry no `Policies` property (checked), which is the favourable case. After the next deploy `aws iam list-role-policies` still lists `AWSRevokeOlderSessions` (or does not) |
| U3 | An `update-function-configuration` description change recycles warm execution environments of the three functions | Open (writes). 5.4: a new `INIT_START` in each log group after the update, and a token minted under the old key being refused. `chatticus-541dc7` settles it |
| U4 | The Front Door and the ComputerStarter keep the signing key for the container's lifetime | Resolved by reading the code: `front-door.ts` keeps `composed` in a module variable, `computer-starter.ts` keeps `cachedDependencies`; both read the parameter while composing |
| U5 | Staging and production have no owner path | Resolved: the signing key parameter exists in development only (the staging and production names are not found) and the staging and production ControlPlane stacks have no `OwnerCredentialBroker` resource |
| U6 | The exact message members see when a turn dies because the key rotated or the owner was lost, and the cold start time | Open. Do the rotation drill on development (5.2) with a member turn in flight, and read the web app |
| U7 | The shape of the `AssumeRole` row on a real match, and the populated-tenant audit query projection | Open. Development has no owner log lines and no audit rows to match; run 9.1 and 9.3 after any normal computer turn on development |
| U8 | Whether `bin/acceptance.ts` exercises a computer turn | Resolved: it does not (10.1 step 4) |
| U9 | Whether a 401 for a bad signature precedes body validation on the owner routes | Resolved: it does; a made-up `ct1.` token and an empty body answered 401 `invalid_credential` on development (5.4) |
| U10 | S3 and DynamoDB data events in staging and production | Resolved: data events are not recorded in any environment, by decision; management events are kept by `chatticus-audit-trail` once its stack is deployed (9.3) |
| U11 | The reach and timing of every "after 2b" statement | Resolved: 2b is live; the page now states the 2b behaviour only. Re-read the numbers (40 minutes, 8 hours) when the constants in `host-protocol/src/supervisor.ts` change |
| U12 | The commands of 1.2 beyond what was run | Narrowed. Ran as written on development (against the 0.1 variables): the stack lookups, the function configuration reads, `logs start-query` on the broker, the Front Door and the supervisor groups (no rows), `ecs list-tasks` (no task running), `iam simulate-principal-policy`, `simulate-role-access.ts`, the DynamoDB queries, `lookup-events`, `describe-parameters`, `rotate-invoke-key.sh --dry-run`, the forged-token probe. Not run because they change something or need a live owner: 1.1 against a real leaked credential, `ecs describe-tasks --include TAGS` on a real task, 2.1 success path, 2.2, 3.2, 5.2, 7 |
| U13 | A second reader following this page once | Done 2026-10-20 (the corrections above are the result). A third reader should repeat 2.2 and 3 on the first development owner that exists |

Related: [Owner credential renewal](OWNER_CREDENTIAL_RENEWAL.md) 12.1 to 12.3, [Owner supervisor protocol](OWNER_SUPERVISOR_PROTOCOL.md)
section 7 (the broker), [AWS authentication](AWS_AUTH.md) (invoke key rotation, no minted keys),
[Role access guard](ROLE_ACCESS_GUARD.md), [Live files protocol](LIVE_FILES_PROTOCOL.md) (the audit), [Operator organization
seed](OPERATOR_ORG_SEED.md) (suspend and reinstate), [Threat model](THREAT_MODEL.md).
