# Infra

AWS CDK (TypeScript).

Planned stacks:

- Control plane: API Gateway, Lambda HTTP edges, SQS, EventBridge, RDS
  Postgres, S3, Secrets Manager
- Computer: ECS Fargate task definition for the computer image, optional
  stop/start EC2, EFS for `/workspace`, IAM for local workers that pull SQS

Local workers authenticate with IAM credentials or SSM; they open no inbound
ports.
