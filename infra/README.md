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
| `ChatticusGitHubDeploy` | GitHub Actions OIDC IAM role for CDK deploy workflows (development ThinTurn + Web) |
| `ChatticusThinTurn` | **Development** thin turn: DynamoDB, SQS, Lambda SSE function URL |
| `ChatticusThinTurnStaging` | Staging thin turn (same shape; deployed from `main`) |
| `ChatticusThinTurnProduction` | Production thin turn (gated deploy of a staging-proven release; never implied by a git branch) |
| `ChatticusWeb` | **Development** Next.js on S3 + CloudFront at `dev.chattic.us` with same-origin `/api/*` |
| `ChatticusWebStaging` | Staging web at `staging.chattic.us` |
| `ChatticusWebProduction` | Production product workspace at `hey.chattic.us` (marketing stays at `chattic.us` / `www`) |

Each thin-turn stack exports the Lambda **function URL** and invoke-key
secret ARN for the matching web stack. The web stack publishes:

- `/chatticus/{environment}/web/site-url` — `https://{hostname}`
- `/chatticus/{environment}/thin-turn/cloudfront-url` — `https://{hostname}/api` (same-origin API base for workers and acceptance)

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

Deploy thin-turn, then the unified web stack (builds `web/` during deploy):

```bash
cd infra
sh deploy-chatticus-web-development.sh
```

Staging and production, when you mean to:

```bash
npx cdk deploy ChatticusThinTurnStaging
npx cdk deploy ChatticusWebStaging
npx cdk deploy ChatticusThinTurnProduction
npx cdk deploy ChatticusWebProduction
```

GitHub Actions (development): manual `workflow_dispatch` workflows on the
`development` environment. Wire OIDC once (below), redeploy
`ChatticusGitHubDeploy` after adding a new trusted workflow path, then set
the `development` environment secret **`AWS_DEPLOY_ROLE_ARN`**. No
CodePipeline. Staging and production workflows are not in scope yet.

| Workflow | File | Script | Stacks |
| --- | --- | --- | --- |
| **Deploy ThinTurn (development)** | `deploy-thinturn-development.yml` | `deploy-chatticus-thinturn-development.sh` | `ChatticusThinTurn` only |
| **Deploy Web (development)** | `deploy-web-development.yml` | `deploy-chatticus-web-development.sh` | `ChatticusThinTurn`, then `ChatticusWeb` |

ThinTurn-only deploy applies ECS host-start context (`computerHostStart=ecs`,
`computerHostCommand=host-worker`) when ChatticusComputers exists. The web
workflow runs that script first so a Web deploy cannot drop RunTask wiring,
then deploys `ChatticusWeb` (builds `web/` during CDK deploy). Neither
workflow touches staging, production, snapshots, or computers stacks.

### GitHub Actions OIDC (one-time)

The account already has an IAM OIDC provider for
`token.actions.githubusercontent.com`. Deploy the CDK stack that creates
the GitHub Actions deploy role:

```bash
cd infra
sh deploy-chatticus-github-deploy.sh
```

Copy the **`GithubDeployRoleArn`** output. Do **not** store long-lived
`AWS_ACCESS_KEY_ID` secrets for this workflow; OIDC assumes a role per run.

The role **`chatticus-github-actions-deploy`** trusts:

- GitHub environment **`development`**
- Workflow ref patterns (explicit list; `workflow_dispatch` from any branch):
  - `AnthusAI/Chattic.us/.github/workflows/deploy-thinturn-development.yml@*`
  - `AnthusAI/Chattic.us/.github/workflows/deploy-web-development.yml@*`
- Audience `sts.amazonaws.com`

It has `AdministratorAccess` so CDK can deploy `ChatticusThinTurn` /
`ChatticusWeb` and the development deploy scripts can read
`ChatticusComputers` outputs for ECS host-start context. It does **not**
deploy snapshots, computers, staging, or production stacks by itself —
each workflow runs only its named development script.

After merging a change that adds or updates trusted workflow paths, redeploy
`ChatticusGitHubDeploy` once (`sh deploy-chatticus-github-deploy.sh`) before
the new workflow can assume the role.

1. **GitHub repository** → Settings → Environments. Create a
   **`development`** environment for the phase-1 workflow (add `staging` and
   `production` when those workflows exist).

2. In `development`, add secret **`AWS_DEPLOY_ROLE_ARN`** with the
   **`GithubDeployRoleArn`** value from the stack output.

3. Run **Actions → Deploy ThinTurn (development)** or **Deploy Web
   (development) → Run workflow** (`workflow_dispatch` appears in the Actions
   UI only after the workflow YAML is on the default branch `main`).

CI (`ci.yml`) does **not** deploy to AWS; only manual deploy workflows do.

Then:

```bash
export CHATTICUS_SNAPSHOT_BUCKET=<SnapshotBucketName output>
export CHATTICUS_DEVELOPMENT_BASE_URL=https://dev.chattic.us/api
```

Acceptance and workers use the `/api` base URL on the site hostname.

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

Every deployment account carries one AWS Budget on `ChatticusSnapshots`
when a human sets the monthly limit and notification address. The CDK
app refuses invented defaults: unset context omits budget resources (CI
`synth` path); partial context fails synth.

```bash
export CHATTICUS_BUDGETS_MONTHLY_LIMIT_USD=<monthly-limit>
export CHATTICUS_BUDGETS_NOTIFICATION_EMAIL=<owner-email>
cd infra
sh deploy-chatticus-snapshots.sh
```

Named deploy scripts source `budgets-deploy-context.sh` and forward the
same `-c` flags when those env vars are set. Never `cdk deploy --all`.

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
