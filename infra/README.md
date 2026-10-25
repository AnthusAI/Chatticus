# Infra

AWS CDK (TypeScript). **Every AWS resource is defined in this directory.** Do
not create buckets, clusters, roles, or repositories with the AWS CLI or
the console. `cdk bootstrap` and `cdk deploy` are the only AWS write
operations.

## Stacks

| Stack | Resources |
| --- | --- |
| `ChatticusSnapshots`, `ChatticusSnapshotsDevelopment`, `ChatticusSnapshotsStaging` | S3 bucket for computer packs; IAM role local hosts may assume. One per environment, all in the production account: the unsuffixed id is production's (it already exists there); `...Development` and `...Staging` are their environments' |
| `ChatticusComputers`, `ChatticusComputersDevelopment`, `ChatticusComputersStaging` | One per environment (unsuffixed is production's; the others carry their environment). VPC, ECR, ECS cluster, the cluster network (subnets and security group, exported as outputs), and the owner task definition `ChatticusComputerOwner` (`ChatticusComputerOwnerDevelopment`, `ChatticusComputerOwnerStaging`; Fargate ARM64, 256 CPU, 512 MiB, init process, 90 second stop timeout) with a deliberately empty task role. There is no always-defined service; the starter runs the task on demand |
| `ChatticusDns` | Route 53 hosted zone for `chattic.us`, ACM certificate (`chattic.us`, `*.chattic.us`, `www.chattic.us`) |
| `ChatticusGitHubDeploy` | GitHub Actions OIDC IAM roles for CDK deploy workflows in the legacy account (development, staging, production); not used by the production account |
| `ChatticusAccountDeploy` | The production account: the GitHub OIDC provider of the account (the one provider, created here and imported by the other two deploy stacks) and production's deploy role `chatticus-github-actions-deploy`, which also denies the development and staging stacks, SSM paths and tagged resources. Not deployed in the legacy account |
| `ChatticusAccountDeployDevelopment`, `ChatticusAccountDeployStaging` | The production account, one per environment: that environment's deploy role (`chatticus-github-actions-deploy-development`, `chatticus-github-actions-deploy-staging`) and its integration test role (`chatticus-github-actions-integration-test-development`, `...-staging`; production has none), importing the OIDC provider that `ChatticusAccountDeploy` created, trusting only that GitHub environment and explicitly denying the other two environments' stacks, SSM parameters and tagged resources. Deploy them after production's |
| `ChatticusEnvironmentZones`, `ChatticusEnvironmentCertificates` (and `...Development`, `...Staging`) | Per environment: the two delegated zones for that environment's web and auth names, and one certificate per name validated inside its own zone. Production's keep their existing unsuffixed ids: renaming them would replace the zones and change their name servers |
| `ChatticusBudgets` | Account-level, one copy. It already exists in the production account, is tagged `production`, and its monthly limit is the combined limit of all three environments; only production deploys it (the deploy script refuses it for development and staging) |
| `ChatticusManagementDns` | In the management account only: the `chattic.us` public hosted zone and its records (retained on stack deletion, termination-protected). Deployed once with `sh deploy-chatticus-management-dns.sh`; instantiated only with `-c managementDns=true` |
| `ChatticusThinTurnDevelopment` | **Development** permanent data stack: Messaging table, invoke secret, operator key SecureString (all retained) and the Node budget jobs. No request compute |
| `ChatticusThinTurnStaging` | Staging data stack (same shape; deployed from `main`) |
| `ChatticusThinTurnProduction` | Production data stack (gated deploy of a staging-proven release; never implied by a git branch) |
| `ChatticusWebDevelopment` | **Development** Next.js on S3 + CloudFront at `develop.chattic.us` with same-origin `/api/*` |
| `ChatticusWebStaging` | Staging web at `staging.chattic.us` |
| `ChatticusWebProduction` | Production product workspace at `hey.chattic.us` (marketing stays at `chattic.us` / `www`) |
| `ChatticusAuthDevelopment` | **Development** Cognito user pool with Google federation at `auth-develop.chattic.us` |
| `ChatticusAuthStaging` | Staging Cognito auth at `auth-staging.chattic.us` |
| `ChatticusAuthProduction` | Production Cognito auth at `auth.chattic.us` |

Each thin-turn stack exports its Messaging table and invoke key to the
control-plane and web stacks, plus the invoke and (retired) operator secret ARNs. The web
stack publishes:

- `/chatticus/{environment}/web/site-url` — `https://{hostname}`
- `/chatticus/{environment}/thin-turn/cloudfront-url` — `https://{hostname}/api` (same-origin API base for workers and acceptance)
- `/chatticus/{environment}/provisioning/customer-role-template-url` — `https://{hostname}/provisioning/customer-role.yml` (customer cross-account IAM setup; source file is `infra/customer-role.yml`, deployed by the same `DeployWebsite` `BucketDeployment` as the SPA)

**Generated runtime keys are SSM SecureStrings.** The operator key
(`/chatticus/<env>/thin-turn/operator-key`, thin-turn stack) and the development
model gateway signing key (`/chatticus/development/model-gateway/signing-key`,
control-plane stack) are standard SecureStrings under the default `aws/ssm` key,
created once by the `GeneratedSecureString` construct (a Provider-framework
custom resource; the value never enters a template, a log or a response).
Invoke keys, the intake origin key and the Google OAuth secrets stay in Secrets
Manager because CloudFront headers, Cognito provider details and Lambda
environment values cannot take an SSM SecureString at deploy time. **Deploy
order: thin-turn before control-plane**, because the control-plane Front Door
reads the operator key parameter that the thin-turn stack creates. The retired
Secrets Manager `OperatorKey` and `ModelGatewaySigningKey` constructs, their
`operator-key-secret-arn` SSM parameters and exports are gone from the
templates; the retained secrets themselves are scheduled for deletion by the
owner-approved runbook, not by a deploy.

**Customer cross-account template:** `infra/customer-role.yml` is the only
template. Each `ChatticusWeb*` stack publishes it at
`https://{hostname}/provisioning/customer-role.yml` (development:
`develop.chattic.us`; staging and production hostnames exist in SSM but web
CloudFront is enabled). Customers and runbooks **GET** that
URL (HTTPS; body is this file unmodified) and pass the YAML to
`aws cloudformation create-stack --template-body`. CloudFormation rejects a
CloudFront distribution URL as `--template-url`; do not use `--template-url`
with the published hostname. Example:

```bash
curl -fsS "https://develop.chattic.us/provisioning/customer-role.yml" \
  -o /tmp/customer-role.yml
aws cloudformation create-stack ... \
  --template-body file:///tmp/customer-role.yml
```

Changes to the file are customer-visible; existing customers re-run or update
their stack. Never duplicate this file or broaden it to `AdministratorAccess`.

Each auth stack publishes (under the same web prefix):

- `/chatticus/{environment}/web/cognito-user-pool-id`
- `/chatticus/{environment}/web/cognito-app-client-id`
- `/chatticus/{environment}/web/cognito-auth-domain` — single-label hostname (`auth-develop`, `auth-staging`, `auth`) on the shared `*.chattic.us` certificate from `ChatticusDns`

Google OAuth client id and secret are **not** in CDK or git. Each auth stack
imports `chatticus/{environment}/oauth/google` from Secrets Manager (seeded
by the human in Kanbus **0ab02c**). Cognito authenticates only; membership
and roles are resolved server-side from DynamoDB.

The snapshot bucket name is a CDK output. Hosts set
`CHATTICUS_SNAPSHOT_BUCKET` to that value. URIs look like
`s3://{SnapshotBucketName}/tenants/{tenant}/computers/{computer}/snapshot`.

v1 AWS computers are **Fargate**. The stack defines the owner task definition and
the cluster network; it runs nothing. The ComputerStarter runs the owner task on
demand. Optional stop/start EC2 is not this stack.

## DNS (one-time)

Deploy the shared DNS stack first:

```bash
cd infra
sh deploy-chatticus-dns.sh
```

Copy the **NameServers** output (four Route 53 NS hostnames). At the
**chattic.us domain registrar**, replace the current name servers with
those four values. Delegation can take up to 48 hours; ACM DNS validation
for the site certificate usually completes soon after propagation.

Until delegation finishes, do not expect `develop.chattic.us` or
`chattic.us` to resolve. The web stacks still deploy; CloudFront serves
the distribution domain name immediately.

## Deploy web + API

Development, staging and production all live in the one production AWS account
(profile `chatticus-production`). Every environment deploys one stack at a time
through the same script, which refuses the legacy account and `--all`, and uses
`--exclusively` so CDK does not follow `web.addDependency` into another stack:

```bash
cd infra
sh deploy-chatticus-dedicated-account.sh development control-plane
sh deploy-chatticus-dedicated-account.sh development web
sh deploy-chatticus-dedicated-account.sh development thin-turn
sh deploy-chatticus-dedicated-account.sh development auth
```

Staging and production, when you mean to, with the same script and their own name:

```bash
sh deploy-chatticus-dedicated-account.sh staging control-plane
sh deploy-chatticus-dedicated-account.sh staging web
sh deploy-chatticus-dedicated-account.sh staging thin-turn
```

GitHub Actions: the development deploy workflows run on **push** to `develop` and on
**`workflow_dispatch`**. The staging and production deploy workflows run on
**`workflow_dispatch` only**, and every one of them deploys through
`deploy-chatticus-dedicated-account.sh`, which refuses the legacy account. The
GitHub environments have no required reviewers (owner decision, 2026-10-15). No
CodePipeline. The three cloud environments share one AWS account, and each GitHub
environment assumes its own environment's OIDC deploy role in it (see below).

Wire OIDC once (below), then set **`AWS_DEPLOY_ROLE_ARN`** in each GitHub
environment from the matching stack output.

| Workflow | File | Script | Stack |
| --- | --- | --- | --- |
| **Deploy ThinTurn (development)** | `deploy-thinturn-development.yml` | `deploy-chatticus-dedicated-account.sh development thin-turn` | `ChatticusThinTurnDevelopment` |
| **Deploy Web (development)** | `deploy-web-development.yml` | `deploy-chatticus-dedicated-account.sh development web` | `ChatticusWebDevelopment` |
| **Deploy Auth (development)** | `deploy-auth-development.yml` | `deploy-chatticus-dedicated-account.sh development auth` | `ChatticusAuthDevelopment` |
| **Deploy ThinTurn (staging)** | `deploy-thinturn-staging.yml` | `deploy-chatticus-dedicated-account.sh staging thin-turn` | `ChatticusThinTurnStaging` |
| **Deploy Web (staging)** | `deploy-web-staging.yml` | `deploy-chatticus-dedicated-account.sh staging web` | `ChatticusWebStaging` |
| **Deploy Auth (staging)** | `deploy-auth-staging.yml` | `deploy-chatticus-dedicated-account.sh staging auth` | `ChatticusAuthStaging` |
| **Deploy ThinTurn (production)** | `deploy-thinturn-production.yml` | `deploy-chatticus-dedicated-account.sh production thin-turn` | `ChatticusThinTurnProduction` |
| **Deploy Web (production)** | `deploy-web-production.yml` | `deploy-chatticus-dedicated-account.sh production web` | `ChatticusWebProduction` |
| **Deploy Auth (production)** | `deploy-auth-production.yml` | `deploy-chatticus-dedicated-account.sh production auth` | `ChatticusAuthProduction` |

For computers in Anthus's own accounts the ComputerStarter runs the owner task
(`ChatticusComputerOwner`, `node /opt/chatticus/host/supervisor.mjs`). The starter
signs one bootstrap token (the signing key is a secret in the ControlPlane stack),
puts it in the task, and assumes no role. The supervisor in the container exchanges
the token at the Front Door, which asks the `OwnerCredentialBroker` Lambda for
credentials. The broker is the only principal that assumes `ComputerSupervisorRole`
(session tags `tenant`, `computer`; the snapshot objects of one computer) and
`ComputerOwnerScopedRole` (five session tags; one conversation), and only the Front
Door may invoke it. This is wired in development only; staging and production do
not run it yet. See [Owner supervisor protocol](../docs/OWNER_SUPERVISOR_PROTOCOL.md)
and [Pi session handoff](../docs/PI_SESSION_HANDOFF.md). The host-start context
below (cluster, subnets, security group) is read from the `ChatticusComputers`
outputs `ComputerClusterName`, `ComputerSubnetIds` and `ComputerSecurityGroupId`.

ThinTurn deploy scripts optionally apply ECS host-start context
(`computerHostStart=ecs`) when
`ChatticusComputers` outputs exist in the same account; missing computers
outputs are ignored (deploy proceeds without ECS context). Workflows never
deploy `ChatticusComputers`, snapshots, DNS, or budgets. Web workflows deploy
one named web stack only (builds `web/` during CDK deploy).

### GitHub Actions OIDC (one-time)

The production account has one IAM OIDC provider for
`token.actions.githubusercontent.com`, created by production's
`ChatticusAccountDeploy`. Each environment's deploy stack creates (or imports the
provider for) that environment's deploy role:

```bash
cd infra
sh deploy-chatticus-account-deploy.sh development
sh deploy-chatticus-account-deploy.sh staging
```

Production's `ChatticusAccountDeploy` already exists and owns the provider; it is
not redeployed to add development (see "Known boundary" below). The development
and staging stacks import its provider, and the script refuses an account that has
no `CDKToolkit` stack or no production `ChatticusAccountDeploy`. The integration
test role of each reads `/chatticus/<env>/thin-turn/invoke-key-secret-arn` while
CloudFormation deploys, so an environment's account-deploy stack can only be
deployed after its `ChatticusThinTurn<Env>` stack exists. Copy the role ARN
outputs. Do **not** store long-lived `AWS_ACCESS_KEY_ID`
secrets for deploy workflows; OIDC assumes a role per run. This is a hard
control — see `docs/AWS_AUTH.md` for the full policy, verification
commands, and legacy-key cleanup.

| GitHub environment | IAM role | Stack | Output for `AWS_DEPLOY_ROLE_ARN` |
| --- | --- | --- | --- |
| `development` | `chatticus-github-actions-deploy-development` | `ChatticusAccountDeployDevelopment` | `GithubDeployRoleArn` |
| `staging` | `chatticus-github-actions-deploy-staging` | `ChatticusAccountDeployStaging` | `GithubDeployRoleArn` |
| `production` | `chatticus-github-actions-deploy` | `ChatticusAccountDeploy` | `GithubDeployRoleArn` |

The development and staging environments also have an integration test role
(`chatticus-github-actions-integration-test-<environment>`, output
`IntegrationTestRoleArn`) that is the value of the
`CHATTICUS_INTEGRATION_TEST_ALLOWED_ROLE_ARN` variable of that GitHub
environment; production has none.

Each role trusts only its GitHub environment name through the OIDC `sub` claim
(audience `sts.amazonaws.com`, repository pinned by numeric id); the trust is not
scoped by workflow file or branch. No role has `AdministratorAccess`. Each
is defined by `deployRoleStatements` in `lib/deploy-role-policy.ts`: `sts:AssumeRole` on the four CDK bootstrap roles
(deploy, file-publishing, image-publishing, lookup; never the CloudFormation execution role), read-only
CloudFormation calls on its own environment's stacks and `CDKToolkit`, `ssm:GetParameter` under
`/chatticus/<environment>/` and the bootstrap version parameter, `secretsmanager:ListSecretVersionIds` on secrets
tagged with its environment, and the ECR push actions on its own environment's computer repository. Explicit denies
cover IAM users, access keys and login profiles, `organizations:*` and `account:*`, plus the peer environment's
stacks, parameters and tagged resources of the other two environments, which share the account.

**Known boundary.** Those denies bound only what the OIDC role does with its own
credentials. All three roles can assume the shared CDK bootstrap roles, and the
bootstrap CloudFormation execution role is `AdministratorAccess`, so a deploy driven
through bootstrap can still change any environment's resources: the denies do not
isolate the environments from one another. Today the boundary is procedural:
staging and production deploy only from `main`, development from `develop`. The
real fix, a separate CDK bootstrap qualifier per environment, is a follow-up.
`test/deploy-role-least-privilege.test.ts` fails when a workflow or script calls an AWS API the role lacks.

1. **GitHub repository** → Settings → Environments. Ensure **`development`**,
   **`staging`**, and **`production`** exist. Do not add required
   reviewers (owner decision, 2026-10-15: no deploy approval gate); each
   environment keeps a deployment branch policy that allows `main` only.

2. In each environment, set secret **`AWS_DEPLOY_ROLE_ARN`** from the
   matching stack output above.

3. Deploys also run on **push** to the environment branch, or manually via
   **Actions → Deploy … (environment) → Run workflow** (`workflow_dispatch`).

CI (`ci.yml`) does **not** deploy to AWS; only the named deploy workflows above do.

Then:

```bash
export CHATTICUS_SNAPSHOT_BUCKET=<SnapshotBucketName output>
export CHATTICUS_DEVELOPMENT_BASE_URL=https://develop.chattic.us/api
```

Acceptance and workers use the `/api` base URL on the site hostname.

## OpenAI API key (per deployment)

The TypeScript control plane (the `FrontDoor` and `TurnExecutor` Lambdas in
`ChatticusControlPlane*`) reads its OpenAI key at **runtime** from a
deployment-scoped SSM SecureString, one path per environment (the same
vendor key may be seeded in all three until dedicated projects exist).
CDK imports the parameter path only (`fromSecureStringParameterAttributes`);
it does **not** create the parameter or embed the key in CloudFormation.

| Environment | SSM path |
| --- | --- |
| development | `/chatticus/development/thin-turn/openai-api-key` |
| staging | `/chatticus/staging/thin-turn/openai-api-key` |
| production | `/chatticus/production/thin-turn/openai-api-key` |

**Human prerequisite** (before live OpenAI turns in a deployment):

1. In the [OpenAI platform](https://platform.openai.com/), create a
   **project** for this deployment (e.g. `chatticus-development`).
2. Create an API key scoped to that project. Never commit the key to git.
3. Store it in SSM:

```bash
export ENV=development   # or staging | production
aws ssm put-parameter \
  --name "/chatticus/${ENV}/thin-turn/openai-api-key" \
  --type SecureString \
  --value "sk-..." \
  --overwrite \
  --description "OpenAI API key for Chatticus ${ENV} thin-turn"
```

`npx cdk synth` and the control-plane deploy succeed without the parameter
existing (import-only reference). The Lambdas set `OPENAI_API_KEY_PARAMETER`,
so a live turn raises SSM `ParameterNotFound` until the SecureString above is
seeded.

Deploy **one named control-plane stack** after seeding SSM for that
environment, for example:

```bash
sh deploy-chatticus-dedicated-account.sh development control-plane
```

Never `cdk deploy --all`.

## Deploy thin-turn only

```bash
cd infra
sh deploy-chatticus-dedicated-account.sh development thin-turn
```

Deploy **one** stack at a time. `cdk deploy --all` and `npm run deploy`
are forbidden (`npm run deploy` exits nonzero). Do not destroy
any environment's snapshots or computers stack.

In the production account the whole list below is run for staging only: production
is already deployed under its existing stack names. The first owner start needs the environment's tag (`dev`,
`staging` or `production`) in `ComputerRepositoryUri`: let the build workflow push `sha-<commit>`, then run the promotion workflow (`docs/COMPUTER_IMAGE_PROMOTION.md`).
Publishing a snapshot does not require a running task.

## Budgets (account-level AWS meter)

Every deployment account carries one AWS Budget in a dedicated
`ChatticusBudgets` stack when a human sets the monthly limit and
notification address. The CDK app registers that stack only when both
`-c` context flags are present; CI `synth` omits it. Partial context
fails synth. Routine snapshot deploys never touch budget resources.

```bash
export CHATTICUS_BUDGETS_MONTHLY_LIMIT_USD=<monthly-limit>
export CHATTICUS_BUDGETS_NOTIFICATION_EMAIL=<owner-email>
cd infra
sh deploy-chatticus-budgets.sh
```

`deploy-chatticus-budgets.sh` and the three ThinTurn deploy scripts source
`budgets-deploy-context.sh`; no other script does. ThinTurn needs it because the
daily rollup Lambda exists only when budget context reaches that stack. The CI
workflows pass the limit from the repository variable
`CHATTICUS_BUDGETS_MONTHLY_LIMIT_USD` and the email from the secret
`CHATTICUS_BUDGETS_NOTIFICATION_EMAIL`. A ThinTurn deploy with neither set
removes an existing rollup, so keep both set.
That script requires both env vars and never runs `cdk deploy` without
them. Never `cdk deploy --all`.

**Cutover (account that already had the budget on `ChatticusSnapshots`):**

AWS budget names are unique per account (`chatticus-monthly-aws`). You
cannot create `ChatticusBudgets` while the old stack still owns that
name. After this change merges:

1. `sh deploy-chatticus-snapshots.sh` — removes the budget from the
   Snapshots template; CloudFormation deletes the Snapshots-owned budget
   and SNS topic (brief alert gap).
2. Immediately `sh deploy-chatticus-budgets.sh` — recreates the same
   budget name and a new SNS topic in `ChatticusBudgets`.

Limit changes redeploy only `ChatticusBudgets`, not snapshots.

**Runbook (not code):**

- Confirm the SNS email subscription after deploy.
- Activate cost allocation tags (`chatticus:environment`, `chatticus:component`,
  `chatticus:tenant`) in the AWS Billing console before Cost Explorer
  breakdowns appear. Activation is not retroactive.
- A new account may report nothing for roughly a day while Cost Explorer
  populates; a quiet first day is normal, not a broken alarm.
- After `ChatticusBudgets` is deployed, redeploy each named ThinTurn stack
  so the daily rollup Lambda and AWS Budgets alert recorder subscribe to
  the same SNS topic. Rollup runs on a UTC schedule and writes org x env x
  day rows in the environment messaging table. Vendor threshold alerts use
  the same 50/80/100% bands as the account AWS budget limit; rollup
  threshold messages are distinct from native AWS Budgets payloads so the
  alert recorder does not loop.
- OpenAI hard spend caps are **console-only** on the vendor project.

## Synth (no AWS credentials required)

Synth validates CloudFormation templates without deploying. CI runs
`npx cdk synth` for every stack. Build the web app first so the web
stack asset path exists:

```bash
npm install
npm run build --workspace=web
npm run synth --workspace=infra
```

Before promoting to `main` or a gated production deploy, confirm the
named thin-turn and web stacks still synth clean:

```bash
npx cdk synth ChatticusThinTurnStaging
npx cdk synth ChatticusWebStaging
```

`ChatticusSnapshots` and `ChatticusComputers` are per environment (production keeps the
unsuffixed ids it already has; development is `...Development` and staging `...Staging`); synth them only when those
definitions change. Never `cdk deploy --all`.

## Computer image pipeline

`.github/workflows/build-computer-image-development.yml` builds, checks and
pushes the computer image to the `ChatticusComputersDevelopment` ECR repository
under the immutable `sha-<git sha>` tag only; the image is no longer pushed by
hand. It keeps its own workflow (it triggers on push to `develop`; the release
build, `build-computer-image-release.yml`, triggers on `main` and pushes the
staging and production repositories). The
`dev` tag moves only through
`.github/workflows/promote-computer-image-development.yml` (see
`docs/COMPUTER_IMAGE_PROMOTION.md`).
`computer/push-computer-image.sh` is break-glass only. The workflow assumes the
development deploy role (`AWS_DEPLOY_ROLE_ARN`). The `ChatticusAccountDeployDevelopment`
stack grants that role `ecr:GetAuthorizationToken`, the ECR push actions on the
development Computers repository only, and `cloudformation:DescribeStacks`
on `ChatticusComputersDevelopment`.

Deploy order: the role change reaches the account only when
`ChatticusAccountDeployDevelopment` is deployed by hand once, with the production
account's credentials (production's `ChatticusAccountDeploy` first):

```bash
cd infra && sh deploy-chatticus-account-deploy.sh development
```

Until then the workflow cannot push. Deploying the `ChatticusComputersDevelopment`
stack itself (`sh deploy-chatticus-dedicated-account.sh development computers`) is a
separate manual step and is not part of the image pipeline.

## One account for every environment

Development, staging and production are separate environments in a single AWS
account, the production account, in `us-east-1`. (The former separate development
account is retired; legacy keeps `ChatticusGitHubDeploy`, three roles in the legacy
account, until the legacy account is retired.) One-time steps run with the
production account's own non-root SSO credentials (profile `chatticus-production`)
and never the legacy account's.

The account is already bootstrapped and holds production's stacks under the names
above; nothing production is renamed. `cdk diff` first (with `--no-change-set` for
a read-only comparison) and expect no replacement. Development and staging are
added next to it:

1. Bootstrap (`npx cdk bootstrap aws://ACCOUNT_ID/us-east-1 --profile PROFILE`)
   already happened; the bootstrap roles are shared by all three environments (see
   "What the shared account does not isolate" in `docs/PROMOTE_TO_MAIN.md`).
2. Each added environment's stacks, one at a time, through
   `sh deploy-chatticus-dedicated-account.sh ENV STACK`, in the order under
   "Deploying an environment into the account" below. The first stacks
   (snapshots, computers, zones, certificates, thin-turn, control-plane, auth, web)
   are deployed locally by an admin session; CI deploys take over once the
   environment's account-deploy stack and GitHub environment secrets exist. The
   account's budget is production's; the script refuses `development budgets` and
   `staging budgets`.
3. `sh deploy-chatticus-account-deploy.sh ENV` (`development`, `staging`) after
   that environment's thin-turn stack exists (its integration test role resolves
   the thin-turn invoke key parameter at deploy time). Redeploy
   `ChatticusAccountDeployStaging` as well: its peer list now includes
   development, an in-place IAM policy change. Do **not** redeploy production's
   `ChatticusAccountDeploy` as part of this move (owner rule: the production deploy
   stack is never touched). The template in the repository is ahead of the deployed
   stack by additive denies of the development stacks only; deploying it later only
   adds those explicit denies to production's role and changes nothing else.

Then set a GitHub **environment secret** named
`AWS_NEW_ACCOUNT_DEPLOY_ROLE_ARN` on the matching GitHub environment from the
stack output, and dispatch `verify-account-deploy-role.yml` for that
environment. It assumes the role through real OIDC and confirms the account is
bootstrapped.

The live `AWS_DEPLOY_ROLE_ARN` secret is what decides which account a deploy
workflow targets, so it is left alone until the cutover card: nothing here
changes where any existing workflow deploys. This repository is public, so the
verify workflow takes no role ARN input and prints no account identifiers.

## The chattic.us zone (management account)

The zone lives in the management account (decision on chatticus-4e4819). Its
records are not in the repository: they are read at deploy time from a local
Route 53 export kept outside it, because account-specific CloudFront hosts
never enter a committed file (see `test_committed_tree_does_not_embed_account_origins`).

1. Export the legacy zone with the legacy SSO profile (take the hosted zone id
   from `AGENTS.local.md`):
   `aws route53 list-resource-record-sets --profile legacy --hosted-zone-id ZONE_ID --output json > ~/chatticus-local/chattic-us-zone.json`
2. `sh deploy-chatticus-management-dns.sh ~/chatticus-local/chattic-us-zone.json`
   with the management account's credentials.
3. Verify every name with `dig` against the four name servers in the stack
   output before anything points at them. The registrar change is made by hand,
   outside AWS, only after that.

The stack reproduces every record faithfully or refuses: an unsupported type,
or an alias that does not target CloudFront, fails the deploy instead of being
dropped. The apex NS and SOA are skipped because Route 53 creates them. The
records are transitional: as each environment moves, its names are replaced by
NS delegations to a small zone in that environment's account.

## Deploying an environment into the account

Everything is built with `-c chatticusAccountEnvironment=ENV`, which produces
only that environment's stacks (including its own snapshots, computers, zones
and certificates). Production keeps the unsuffixed ids it already has; development
and staging carry a `Development` or `Staging` suffix because all three share the
production account. These stacks are never the legacy account's.
`ChatticusBudgets` is the one account-level stack: its id is the same whichever
environment builds it, and the account's single copy belongs to production (tagged
`production`), so only production deploys it. The default (no context) still builds the legacy
three-environment account. Development is named
`develop.chattic.us` and `auth-develop.chattic.us`: CloudFront alternate domain
names and Cognito custom domains are unique worldwide, so a name the legacy
environment still holds cannot be reused.

Deploy one stack at a time, in this order, with that account's own credentials
(`sh deploy-chatticus-dedicated-account.sh ENV STACK`, which refuses the legacy
account):

1. `budgets` (production only: it needs `CHATTICUS_BUDGETS_MONTHLY_LIMIT_USD` and
   `CHATTICUS_BUDGETS_NOTIFICATION_EMAIL`, and the account already has it, so
   development and staging skip this step), then per environment `snapshots`,
   `computers`
2. `zones`, then read the two name-server outputs
3. Delegate both names from the management zone (a reviewed change to
   `ChatticusManagementDns`), and wait until `dig` shows the delegation. For
   development this is the delegation follow-up PR that replaces the retired
   account's name servers in `lib/dns-delegations.ts`.
4. `certificates` (validation cannot finish before step 3, so the Development
   certificates stack cannot validate until the follow-up PR points
   `develop.chattic.us` and `auth-develop.chattic.us` at the new zones)
5. `thin-turn` (needs no seeded secrets to deploy)
6. **A person seeds** the Google OAuth secret `chatticus/ENV/oauth/google`
   (read by the auth stack while deploying) and, for live turns, the OpenAI
   SecureString parameter, in that account with their own session
7. `sh deploy-chatticus-account-deploy.sh ENV` for development and staging (needs
   step 5)
8. `control-plane` (development and staging: with
   `CHATTICUS_INTEGRATION_TEST_ALLOWED_ROLE_ARN` set to step 7's integration test
   role ARN)
9. `auth`, then `web` (the web build reads the Cognito ids the auth stack
   publishes, so auth comes first). **Order gate for development:** the retired
   development account's `ChatticusWeb` and `ChatticusAuth` stacks must be deleted
   first. CloudFront alternate domain names and Cognito custom domains are
   globally unique, and those stacks hold `develop.chattic.us` and
   `auth-develop.chattic.us` until they are gone.
