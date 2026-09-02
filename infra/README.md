# Infra

AWS CDK (TypeScript). **Every AWS resource is defined in this directory.** Do
not create buckets, clusters, roles, or repositories with the AWS CLI or
the console. `cdk bootstrap` and `cdk deploy` are the only AWS write
operations.

## Stacks

| Stack | Resources |
| --- | --- |
| `ChatticusSnapshots` | S3 bucket for computer packs; IAM role local hosts may assume |
| `ChatticusComputers` | VPC, ECR, ECS cluster, Fargate ARM64 task definition, service (count 0 by default) |
| `ChatticusDns` | Route 53 hosted zone for `chattic.us`, ACM certificate (`chattic.us`, `*.chattic.us`, `www.chattic.us`) |
| `ChatticusGitHubDeploy` | GitHub Actions OIDC IAM roles for CDK deploy workflows (development, staging, production) |
| `ChatticusThinTurn` | **Development** thin turn: DynamoDB, SQS, Lambda SSE function URL |
| `ChatticusThinTurnStaging` | Staging thin turn (same shape; deployed from `main`) |
| `ChatticusThinTurnProduction` | Production thin turn (gated deploy of a staging-proven release; never implied by a git branch) |
| `ChatticusWeb` | **Development** Next.js on S3 + CloudFront at `dev.chattic.us` with same-origin `/api/*` |
| `ChatticusWebStaging` | Staging web at `staging.chattic.us` |
| `ChatticusWebProduction` | Production product workspace at `hey.chattic.us` (marketing stays at `chattic.us` / `www`) |
| `ChatticusAuth` | **Development** Cognito user pool with Google federation at `auth-dev.chattic.us` |
| `ChatticusAuthStaging` | Staging Cognito auth at `auth-staging.chattic.us` |
| `ChatticusAuthProduction` | Production Cognito auth at `auth.chattic.us` |

Each thin-turn stack exports the Lambda **function URL** and invoke-key
secret ARN for the matching web stack. The web stack publishes:

- `/chatticus/{environment}/web/site-url` — `https://{hostname}`
- `/chatticus/{environment}/thin-turn/cloudfront-url` — `https://{hostname}/api` (same-origin API base for workers and acceptance)

Each auth stack publishes (under the same web prefix):

- `/chatticus/{environment}/web/cognito-user-pool-id`
- `/chatticus/{environment}/web/cognito-app-client-id`
- `/chatticus/{environment}/web/cognito-auth-domain` — single-label hostname (`auth-dev`, `auth-staging`, `auth`) on the shared `*.chattic.us` certificate from `ChatticusDns`

Google OAuth client id and secret are **not** in CDK or git. Each auth stack
imports `chatticus/{environment}/oauth/google` from Secrets Manager (seeded
by the human in Kanbus **0ab02c**). Cognito authenticates only; membership
and roles are resolved server-side from DynamoDB.

The snapshot bucket name is a CDK output. Hosts set
`CHATTICUS_SNAPSHOT_BUCKET` to that value. URIs look like
`s3://{SnapshotBucketName}/tenants/{tenant}/computers/{computer}/snapshot`.

v1 AWS computers are **Fargate**. Run one host with
`npx cdk deploy ChatticusComputers -c computerCount=1`. Scale back with
`-c computerCount=0`. Optional stop/start EC2 is not this stack.

A smoke publish from Fargate into S3:

```bash
sh computer/test_fargate.sh
```

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

Until delegation finishes, do not expect `dev.chattic.us` or
`chattic.us` to resolve. The web stacks still deploy; CloudFront serves
the distribution domain name immediately.

## Deploy web + API (development)

Deploy thin-turn and web as separate one-stack scripts (never chained in one
script). Each uses `--exclusively` so CDK does not follow `web.addDependency`
into the other stack:

```bash
cd infra
sh deploy-chatticus-thinturn-development.sh
sh deploy-chatticus-web-development.sh
sh deploy-chatticus-auth-development.sh
```

Staging and production, when you mean to:

```bash
npx cdk deploy ChatticusThinTurnStaging
npx cdk deploy ChatticusWebStaging
npx cdk deploy ChatticusAuthStaging
npx cdk deploy ChatticusThinTurnProduction
npx cdk deploy ChatticusWebProduction
npx cdk deploy ChatticusAuthProduction
```

GitHub Actions: manual `workflow_dispatch` deploy workflows only. No
CodePipeline. No deploy on push to `develop` or `main`. One AWS account
hosts all three named cloud environments; three GitHub environments
(`development`, `staging`, `production`) each assume a dedicated OIDC role
(see below). A future split into dedicated AWS accounts per environment
would re-scope `ChatticusGitHubDeploy`; this slice assumes one account.

Wire OIDC once (below), redeploy `ChatticusGitHubDeploy` after adding or
updating trusted workflow paths, then set **`AWS_DEPLOY_ROLE_ARN`** in each
GitHub environment from the matching stack output.

| Workflow | File | Script | Stack |
| --- | --- | --- | --- |
| **Deploy ThinTurn (development)** | `deploy-thinturn-development.yml` | `deploy-chatticus-thinturn-development.sh` | `ChatticusThinTurn` |
| **Deploy Web (development)** | `deploy-web-development.yml` | `deploy-chatticus-web-development.sh` | `ChatticusWeb` |
| **Deploy Auth (development)** | `deploy-auth-development.yml` | `deploy-chatticus-auth-development.sh` | `ChatticusAuth` |
| **Deploy ThinTurn (staging)** | `deploy-thinturn-staging.yml` | `deploy-chatticus-thinturn-staging.sh` | `ChatticusThinTurnStaging` |
| **Deploy Web (staging)** | `deploy-web-staging.yml` | `deploy-chatticus-web-staging.sh` | `ChatticusWebStaging` |
| **Deploy Auth (staging)** | `deploy-auth-staging.yml` | `deploy-chatticus-auth-staging.sh` | `ChatticusAuthStaging` |
| **Deploy ThinTurn (production)** | `deploy-thinturn-production.yml` | `deploy-chatticus-thinturn-production.sh` | `ChatticusThinTurnProduction` |
| **Deploy Web (production)** | `deploy-web-production.yml` | `deploy-chatticus-web-production.sh` | `ChatticusWebProduction` |
| **Deploy Auth (production)** | `deploy-auth-production.yml` | `deploy-chatticus-auth-production.sh` | `ChatticusAuthProduction` |

ThinTurn deploy scripts optionally apply ECS host-start context
(`computerHostStart=ecs`, `computerHostCommand=host-worker`) when
`ChatticusComputers` outputs exist in the same account; missing computers
outputs are ignored (deploy proceeds without ECS context). Workflows never
deploy `ChatticusComputers`, snapshots, DNS, or budgets. Web workflows deploy
one named web stack only (builds `web/` during CDK deploy).

### GitHub Actions OIDC (one-time)

The account already has an IAM OIDC provider for
`token.actions.githubusercontent.com`. Deploy the CDK stack that creates
the GitHub Actions deploy roles:

```bash
cd infra
sh deploy-chatticus-github-deploy.sh
```

Copy the role ARN outputs. Do **not** store long-lived `AWS_ACCESS_KEY_ID`
secrets for deploy workflows; OIDC assumes a role per run.

| GitHub environment | IAM role | Stack output for `AWS_DEPLOY_ROLE_ARN` |
| --- | --- | --- |
| `development` | `chatticus-github-actions-deploy` | `GithubDeployRoleArn` |
| `staging` | `chatticus-github-actions-deploy-staging` | `GithubDeployStagingRoleArn` |
| `production` | `chatticus-github-actions-deploy-production` | `GithubDeployProductionRoleArn` |

Each role trusts only its GitHub environment name, audience
`sts.amazonaws.com`, and an explicit list of `job_workflow_ref` patterns
(`workflow_dispatch` from any branch). Each has `AdministratorAccess` for
CDK deploy of its named stacks and read-only lookups of `ChatticusComputers`
outputs used by ThinTurn deploy scripts.

After merging a change that adds or updates trusted workflow paths, redeploy
`ChatticusGitHubDeploy` once (`sh deploy-chatticus-github-deploy.sh`) before
the new workflow can assume the role.

1. **GitHub repository** → Settings → Environments. Ensure **`development`**,
   **`staging`**, and **`production`** exist. Add required reviewers on
   **`production`**.

2. In each environment, set secret **`AWS_DEPLOY_ROLE_ARN`** from the
   matching stack output above.

3. Run **Actions → Deploy … (environment) → Run workflow**
   (`workflow_dispatch`).

CI (`ci.yml`) does **not** deploy to AWS; only manual deploy workflows do.

Then:

```bash
export CHATTICUS_SNAPSHOT_BUCKET=<SnapshotBucketName output>
export CHATTICUS_DEVELOPMENT_BASE_URL=https://dev.chattic.us/api
```

Acceptance and workers use the `/api` base URL on the site hostname.

## OpenAI API key (per deployment)

Each thin-turn stack reads its OpenAI key at **runtime** from a
deployment-scoped SSM SecureString (one path per environment; the same
vendor key may be seeded in all three until dedicated projects exist).
CDK imports the parameter path only; it does **not** create the
parameter or embed the key in CloudFormation (unlike the invoke-key
secret, which CDK generates and unwraps into the Lambda environment).

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

`npx cdk synth` and thin-turn deploy succeed without the parameter
existing (import-only reference). Deployed Lambdas always set
`OPENAI_API_KEY_PARAMETER`, so a live turn that needs OpenAI completion
raises SSM `ParameterNotFound` until the human seeds the SecureString
above. The fake client is only used when that env var is unset (for
example local dev without `.env`).

Deploy **one named thin-turn stack** after seeding SSM for that
environment, for example:

```bash
npx cdk deploy ChatticusThinTurn          # development
npx cdk deploy ChatticusThinTurnStaging   # staging
npx cdk deploy ChatticusThinTurnProduction  # production (gated)
```

Never `cdk deploy --all`.

## Deploy thin-turn only

```bash
cd infra
sh deploy-chatticus-thinturn-development.sh
```

Deploy **one** stack at a time. `cdk deploy --all` and `npm run deploy`
are forbidden (`npm run deploy` exits nonzero). Do not destroy
`ChatticusSnapshots` or `ChatticusComputers`.

A Fargate service exists at count 0 until you deploy
`-c computerCount=1` after pushing `ComputerRepositoryUri:dev`.
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

Only `deploy-chatticus-budgets.sh` sources `budgets-deploy-context.sh`.
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
- OpenAI hard spend caps are **console-only** on the vendor project.

## Synth (no AWS credentials required)

Synth validates CloudFormation templates without deploying. CI runs
`npx cdk synth` for every stack. Build the web app first so the web
stack asset path exists:

```bash
cd web && npm ci && npm run build
cd ../infra && npm ci && npx cdk synth
```

Before promoting to `main` or a gated production deploy, confirm the
named thin-turn and web stacks still synth clean:

```bash
npx cdk synth ChatticusThinTurnStaging
npx cdk synth ChatticusWebStaging
```

`ChatticusSnapshots` and `ChatticusComputers` are shared account stacks;
synth them only when those definitions change. Never `cdk deploy --all`.
