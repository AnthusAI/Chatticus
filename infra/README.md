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
| `ChatticusThinTurn` | **Development** thin turn: DynamoDB, SQS, Lambda SSE, CloudFront |
| `ChatticusThinTurnStaging` | Staging thin turn (same shape; deployed from `main`) |
| `ChatticusThinTurnProduction` | Production thin turn (gated deploy of a staging-proven release; never implied by a git branch) |

Each thin-turn stack publishes SSM
`/chatticus/{environment}/thin-turn/cloudfront-url` and
`/chatticus/{environment}/thin-turn/invoke-key-secret-arn`.
It also creates IAM role `chatticus-{environment}-github-acceptance` for
GitHub Actions OIDC so **Acceptance** can resolve CloudFront and consume
the turn queues. That role cannot deploy or scale computers.

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

## Deploy

Deploy **one** stack at a time. `cdk deploy --all` and `npm run deploy`
are forbidden (`npm run deploy` exits nonzero). Do not destroy
`ChatticusSnapshots` or `ChatticusComputers`.

```bash
cd infra
sh deploy-chatticus-thinturn-development.sh
```

That script calls `aws sts get-caller-identity` first and deploys only
`ChatticusThinTurn`. Staging and production, when you mean to:

```bash
npx cdk deploy ChatticusThinTurnStaging
npx cdk deploy ChatticusThinTurnProduction
```

Then:

```bash
export CHATTICUS_SNAPSHOT_BUCKET=<SnapshotBucketName output>
export CHATTICUS_DEVELOPMENT_BASE_URL=<CloudFrontUrl output>
```

A Fargate service exists at count 0 until you deploy
`-c computerCount=1` after pushing `ComputerRepositoryUri:dev`.
Publishing a snapshot does not require a running task.

## Synth (no AWS credentials required)

Synth validates CloudFormation templates without deploying. CI runs
`npx cdk synth` for every stack. Before promoting to `main` or a gated
production deploy, confirm the named thin-turn stacks still synth clean:

```bash
cd infra
npm install
npx cdk synth ChatticusThinTurnStaging
npx cdk synth ChatticusThinTurnProduction
```

`ChatticusSnapshots` and `ChatticusComputers` are shared account stacks;
synth them only when those definitions change. Never `cdk deploy --all`.
