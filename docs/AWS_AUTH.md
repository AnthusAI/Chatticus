# AWS authentication

Chatticus does **not** create IAM users or mint long-lived IAM access keys.
This is a hard control, not a preference. The organization is transitioning to
AWS IAM Identity Center; every new path must use short-lived credentials from
OIDC, `sts:AssumeRole`, or an Identity Center–compatible session.

Temporary access keys copied out of an `AssumeRole` or OIDC session response
are allowed only as in-process forwarding (for example, SAM docker bundling
or a one-shot shell script). Storing those values in GitHub Secrets, SSM, or
Secrets Manager as a standing credential is forbidden. Creating new
long-lived keys — including "temporary" keys left in place as a workaround —
is forbidden.

## Allowed patterns

| Surface | Auth path | Where defined |
| --- | --- | --- |
| GitHub deploy workflows | GitHub OIDC → `configure-aws-credentials` → `role-to-assume` | `.github/workflows/deploy-*.yml`, `infra/lib/github-deploy-stack.ts` |
| Local / desk deploy | `aws login` (Identity Center or equivalent short-lived session) | `infra/deploy-*.sh` |
| Web CDK bundle (docker) | Forwards the runner's OIDC session into SAM docker | `infra/lib/web-build-env.ts` (`webDockerBundlingEnvironment`) |
| Customer cross-account provisioning | Anthus principal `sts:AssumeRole` into `ChatticusOrganizationComputerRole` | `conversation/src/computer/provisioning.ts`, `infra/customer-role.yml` |
| Customer computer image publish | Operator `aws login` → `sts assume-role` with `ExternalId` | `computer/push-customer-computer-image.sh` |
| Anthus computer image publish | CI: the GitHub OIDC deploy role pushes the image; `computer/push-computer-image.sh` is break-glass only (operator `aws login`) | `.github/workflows/build-computer-image-development.yml`, `computer/push-computer-image.sh` |
| Integration test session exchange | SigV4 caller proves an allowed IAM **role**; control plane returns a bearer token | `features/integration_test_auth.feature`, `infra/lib/integration-test-stack.ts` |
| Operator HTTP routes | Bearer secret in Secrets Manager (not an AWS access key) | `conversation/src/auth/operator.ts` |
| Worker routes | Per-worker minted bearer credential (not an AWS access key) | `features/worker_credentials.feature` |

## Forbidden patterns

Do not add any of the following to this repository or to templates it publishes
for Chatticus or customer accounts:

- `iam:CreateAccessKey`, `CreateAccessKey`, `create_access_key`, `create-access-key`
- CDK `iam.AccessKey`, `CfnAccessKey`, CloudFormation `AWS::IAM::AccessKey`
- Terraform `aws_iam_access_key`
- `aws iam create-access-key` (or create-user for standing operator access)
- GitHub Actions secrets `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` for deploy
- Scripts that mint keys and write them to disk, SSM, or Secrets Manager

## Verify no minting remains

From the repository root:

```bash
rg -n 'CreateAccessKey|create_access_key|create-access-key|iam\.AccessKey|CfnAccessKey|aws_iam_access_key|AWS::IAM::AccessKey|iam:CreateAccessKey' \
  --glob '!**/node_modules/**' --glob '!**/.git/**' \
  --glob '!docs/AWS_AUTH.md' --glob '!infra/test/**'

rg -n 'secrets\.AWS_ACCESS_KEY_ID|secrets\.AWS_SECRET_ACCESS_KEY' .github/workflows/
```

Production paths must return no matches (exclude this policy doc and guard
tests). CI enforces the same rules in
`infra/test/no-iam-access-keys.test.ts` and `infra/test/deploy-workflows.test.ts`.

Legitimate `AccessKeyId` / `AWS_ACCESS_KEY_ID` references are limited to:

- STS `AssumeRole` response handling (`conversation/src/computer/provisioning.ts`, `push-customer-computer-image.sh`)
- Forwarding an existing OIDC session into docker (`web-build-env.ts`)
- Test fixtures and mocks (`conversation/features-support/`, `conversation/test/`)

## Rotating the invoke key

The invoke key is one shared value: CloudFront presents it as the
`X-Chatticus-Invoke-Key` origin header and the Front Door refuses every route
but `/health` without it (the owner host token and the model gateway excepted).
It is a Secrets Manager secret, not an AWS access key, and it is rotated by
`infra/rotate-invoke-key.sh`.

### Who holds the key and how they get it

| Consumer | How it obtains the key | Staleness after a rotation |
| --- | --- | --- |
| CloudFront (Web stack) | Origin custom header, a CloudFormation dynamic reference resolved at **deploy** time (`web-stack.ts`). The Web deploy scripts pin the secret's current version id (`-c invokeKeyVersionId=`) so a rotation changes the template; without that CloudFormation does not re-resolve an unchanged resource. | Until the Web stack is redeployed. |
| FrontDoor Lambda | Reads the secret by ARN at cold start and then at most every 60 seconds (`INVOKE_KEY_CACHE_SECONDS`, `conversation/src/auth/invoke-key-source.ts`). It accepts the `AWSCURRENT` and the `AWSPREVIOUS` value. Before this change it read the secret once per cold start and never again, so a warm container (hours) kept the old key. | 60 seconds. |
| ComputerStarter Lambda | Reads it when it composes its dependencies, now at most every 60 seconds; it is used only to start a customer-account host worker (the key goes into that worker's task environment). | 60 seconds, but see customer workers. |
| Acceptance runner and demo CLI | `conversation/bin/acceptance.ts` reads the secret by ARN from SSM at every run. `chat.ts` holds no key. | None. |
| Browser and static web export | Never. The browser calls `/api/*` on CloudFront, which adds the header. | None. |
| Owner containers | Never; they use a signed host token and a gateway token. | None. |
| Customer-account host workers | `CHATTICUS_INVOKE_KEY` in the task environment the ComputerStarter sets when it starts the worker (`host-starter.ts`), sent on every host-protocol call and at worker registration. | Until the worker is restarted. |
| Integration-test sessions | The HMAC of the integration bearer is derived from the key when a Front Door instance composes. | Bearers minted by an instance on the old key fail on an instance on the new key: only integration test and acceptance sessions, only in the minutes around a rotation. |

Development has no customer-account host workers. In staging and production
every running customer host worker is refused after the previous value is
retired and must be restarted (end the computer and let the next turn start it,
or re-provision); rotate during a quiet period and expect an interrupted
computer turn for those organizations.

### Runbook

Precondition: the Front Door and ComputerStarter that read `AWSPREVIOUS` are
deployed (the `Deploy Web (development)` workflow deploys the control plane
first), and `aws login` / `aws sso login` for the environment is current.

```sh
cd infra
sh rotate-invoke-key.sh development --dry-run      # read-only: steps and checks
sh rotate-invoke-key.sh development --yes          # rotate
```

What it does, in this order:

1. Refuses without an explicit environment and `--yes`; uses the profile
   `chatticus-<environment>` (`CHATTICUS_AWS_PROFILE` overrides); refuses a
   secret that is not in the session's account.
2. Read-only checks: CloudFront and Function URL `/health` answer 200, the
   Function URL refuses a keyless request with the invoke key gate, CloudFront
   passes the gate.
3. `get-random-password` (40 characters, no punctuation) held in memory, then
   `put-secret-value` through stdin. The old value becomes `AWSPREVIOUS`. The
   Front Door accepts both values from here on.
4. Waits 65 seconds so every warm Front Door has read the pair.
5. Redeploys the Web stack (development: `gh workflow run "Deploy Web
   (development)" --ref develop` and watches it; staging and production:
   `deploy-chatticus-dedicated-account.sh <environment> web` from the
   operator session), then waits for the distribution to be `Deployed`.
6. Compares the distribution's origin header with the `AWSCURRENT` value in
   memory (never printed). Only if equal does it go on.
7. Retires `AWSPREVIOUS` (`update-secret-version-stage`), waits 65 seconds and
   re-verifies the open and the protected routes.

If any step fails the script exits non-zero with the reason. Before step 7
nothing is down, because both values are still accepted. Fix the cause and run
`--resume --yes`, which finishes steps 4 to 7 without a new value; a normal run
refuses while a previous value is staged. If `gh` is missing or not logged in
the script prints the exact `gh workflow run` command and exits 3; run it, wait,
then `--resume --yes`. Afterwards run the acceptance runner
(`cd conversation && npx tsx bin/acceptance.ts --environment development`).

### The window

There is no refusal window for web users: for the whole time CloudFront still
carries the old key the Front Door accepts it as `AWSPREVIOUS`, and the first
wait keeps the deploy from beating the Lambda cache. The only exposure is the
old key staying valid until step 7; if it is suspected leaked, do not stop
between steps 3 and 7. If the Web deploy is done by hand with a CloudFront that
takes long to propagate, nothing is lost: both values work. After retirement
the old key is dead everywhere within 60 seconds.

### Cadence

Rotate every 90 days, after anyone with `cloudfront:GetDistributionConfig`,
`secretsmanager:GetSecretValue` on the secret or `ecs:DescribeTasks` on the
host cluster leaves the operator set, and at once on any suspected exposure.

### Proposed, not built: take the key out of the CloudFront configuration

Today the key is plain text in the distribution configuration. The fix is an
origin access control for the Function URL: set the Function URL `authType` to
`AWS_IAM` and let CloudFront sign the origin request (SigV4) with an OAC, so no
shared header exists. Known obstacles from this repo: the STS authorization
relay (integration-test and caller-identity proof, `buildStsGetCallerIdentityHeaders`)
and the worker bearer travel in the `Authorization` header, which the OAC
SigV4 signature would overwrite; direct Function URL callers (customer-account
host workers, the acceptance runner) would need to sign requests themselves or
use a second, separately protected URL; and the Function URL would need a
resource policy for `cloudfront.amazonaws.com` scoped to the distribution ARN.
Until then the rotation above is the control.

## Ops cleanup after cutover

This repository does not mint keys, but historical operator practice and
sibling repos may have left standing credentials. After this control lands,
deactivate and delete any long-lived keys that are not tied to an active
break-glass exception:

| Implied principal | Evidence in repo | Action |
| --- | --- | --- |
| GitHub Actions deploy (Anthus account) | `infra/README.md` OIDC section; workflows use `AWS_DEPLOY_ROLE_ARN` only | Confirm no `AWS_ACCESS_KEY_ID` GitHub secrets remain on `AnthusAI/Chatticus` environments |
| Lab / throwaway customer account operator | `project/wiki/runbooks/throwaway-account-provisioning.md` records IAM user `chatticus-b88c0a-operator` | Deactivate access keys; prefer Identity Center or `OrganizationAccountAccessRole` session |
| Desk / kernel operator sessions | `AGENTS.local.md` (gitignored) may reference role ARNs | Audit `aws iam list-access-keys` in Anthus and customer lab accounts |
| Sibling repos | Not in this checkout | Audit `AnthusAI/Chattic.us-web` and any Anthus operator/kernel automation for `create-access-key` |

Use `aws iam list-users` and `aws iam list-access-keys --user-name <user>` (or
Identity Center permission sets) in each account. Do **not** create replacement
keys while cleaning up — use `aws login` / Identity Center and existing
`AssumeRole` paths instead.

## Related docs

- `infra/README.md` — GitHub Actions OIDC one-time setup
- `AGENTS.md` — agent hard control (summary)
- `infra/customer-role.yml` — customer cross-account role (roles only, no users/keys)
