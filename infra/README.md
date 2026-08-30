# Infra

AWS CDK (TypeScript). **Every AWS resource is defined in this directory.** Do
not create buckets, clusters, roles, or repositories with the AWS CLI or
the console. `cdk bootstrap` and `cdk deploy` are the only AWS write
operations.

## Stacks

| Stack | Resources |
| --- | --- |
| `ChatticusSnapshots` | S3 bucket for computer packs; IAM role local hosts may assume |
| `ChatticusComputers` | VPC, ECR repo, ECS cluster, Fargate task definition and a service at desired count 0 |

The snapshot bucket name is a CDK output. Hosts set
`CHATTICUS_SNAPSHOT_BUCKET` to that value. URIs look like
`s3://{SnapshotBucketName}/tenants/{tenant}/computers/{computer}/snapshot`.

## Deploy

```bash
cd infra
npm install
npx cdk bootstrap
npx cdk deploy --all
```

Then:

```bash
export CHATTICUS_SNAPSHOT_BUCKET=<SnapshotBucketName output>
```

A Fargate service exists at count 0 until a computer image is pushed to ECR
(`ComputerRepositoryUri:dev`) and the service is scaled by another CDK
change. Publishing a snapshot does not require a running task.

## Synth (no AWS credentials required)

```bash
cd infra
npm install
npx cdk synth
```
