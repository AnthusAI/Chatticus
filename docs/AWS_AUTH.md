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
| Customer cross-account provisioning | Anthus principal `sts:AssumeRole` into `ChatticusOrganizationComputerRole` | `python/src/chatticus/cross_account_assume_role.py`, `infra/customer-role.yml` |
| Customer computer image publish | Operator `aws login` → `sts assume-role` with `ExternalId` | `computer/push-customer-computer-image.sh` |
| Anthus computer image publish | Operator `aws login` (same session, no key minting) | `computer/push-computer-image.sh` |
| Integration test session exchange | SigV4 caller proves an allowed IAM **role**; control plane returns a bearer token | `features/integration_test_auth.feature`, `infra/lib/integration-test-stack.ts` |
| Operator HTTP routes | Bearer secret in Secrets Manager (not an AWS access key) | `python/src/chatticus/operator_credentials.py` |
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

- STS `AssumeRole` response handling (`cross_account_assume_role.py`, `push-customer-computer-image.sh`)
- Forwarding an existing OIDC session into docker (`web-build-env.ts`)
- Test fixtures and mocks (`features/steps/`, `python/tests/`)

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
