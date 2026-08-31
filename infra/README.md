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
| `ChatticusThinTurn` | **Development** thin turn: DynamoDB, SQS, Lambda SSE function URL |
| `ChatticusThinTurnStaging` | Staging thin turn (same shape; deployed from `main`) |
| `ChatticusThinTurnProduction` | Production thin turn (gated deploy of a staging-proven release; never implied by a git branch) |
| `ChatticusWeb` | **Development** Next.js on S3 + CloudFront at `dev.chattic.us` with same-origin `/api/*` |
| `ChatticusWebStaging` | Staging web at `staging.chattic.us` |
| `ChatticusWebProduction` | Production web at `chattic.us` and `www.chattic.us` |

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

GitHub Actions (phase 1): workflow **Deploy ThinTurn (development)**
(`deploy-thinturn-development.yml`) with `workflow_dispatch`. It runs
`deploy-chatticus-thinturn-development.sh` so ECS host-start context
(`computerHostStart=ecs`, `computerHostCommand=host-worker`) is applied
when ChatticusComputers exists. It does **not** deploy `ChatticusWeb`,
staging, or production. No CodePipeline. **Not wired yet** until AWS and
GitHub are configured (below).

A follow-up workflow will add web deploy and staging/production gates
after OIDC and the development thin-turn path are proven.

### GitHub Actions OIDC (one-time)

The account already has an IAM OIDC provider for
`token.actions.githubusercontent.com`. You still need a **deploy IAM role**
and GitHub configuration. Do **not** store long-lived `AWS_ACCESS_KEY_ID`
secrets for this workflow; OIDC assumes a role per run.

1. **Create an IAM role** (console or CDK) that GitHub Actions can assume.
   Trust policy (adjust repo/branch as needed):

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": {
           "Federated": "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com"
         },
         "Action": "sts:AssumeRoleWithWebIdentity",
         "Condition": {
           "StringEquals": {
             "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
           },
           "StringLike": {
             "token.actions.githubusercontent.com:sub": "repo:AnthusAI/Chattic.us:*"
           }
         }
       }
     ]
   }
   ```

   Attach a policy that allows CDK deploy for the Chatticus stacks (often
   `AdministratorAccess` for a personal account, or a scoped policy later).

2. **GitHub repository** → Settings → Environments. Create a
   **`development`** environment for the phase-1 workflow (add `staging` and
   `production` when those workflows exist).

3. In `development`, add secret **`AWS_DEPLOY_ROLE_ARN`** with that role’s
   ARN. The workflow reads `secrets.AWS_DEPLOY_ROLE_ARN` from the
   environment.

4. Run **Actions → Deploy ThinTurn (development) → Run workflow**.

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
