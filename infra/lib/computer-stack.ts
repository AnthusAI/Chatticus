import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { CHATTICUS_LOG_RETENTION } from "./log-retention";

export interface ComputerStackProps extends cdk.StackProps {
  snapshotBucket: s3.IBucket;
}

/**
 * Fargate-capable computer hosts. The workplace image is stored in ECR.
 *
 * The service desired count defaults to 0 (scale to 0). Pass
 * ``-c computerCount=1`` to run a host. v1 AWS computers are Fargate ARM64
 * so the same image runs on Apple Silicon Docker and Fargate. Optional
 * stop/start EC2 is later, for a warm EBS cache.
 */
export class ComputerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ComputerStackProps) {
    super(scope, id, props);

    const computerCount = Number(this.node.tryGetContext("computerCount") ?? 0);
    const smokeComputer =
      typeof this.node.tryGetContext("smokeComputer") === "string"
        ? String(this.node.tryGetContext("smokeComputer"))
        : "";

    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    const repository = new ecr.Repository(this, "ComputerImage", {
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      emptyOnDelete: false,
    });

    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
    });

    const taskRole = new iam.Role(this, "ComputerTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "Computer host: publish and hydrate snapshots from S3.",
    });
    props.snapshotBucket.grantReadWrite(taskRole);

    const logGroup = new logs.LogGroup(this, "ComputerLogs", {
      retention: CHATTICUS_LOG_RETENTION,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, "ComputerTask", {
      cpu: 256,
      memoryLimitMiB: 512,
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const computerEnvironment: { [key: string]: string } = {
      CHATTICUS_SNAPSHOT_BUCKET: props.snapshotBucket.bucketName,
      CHATTICUS_LIVE_ROOT: "/var/lib/chatticus/computer",
      CHATTICUS_TENANT_ID: "anthus",
    };
    if (smokeComputer !== "") {
      computerEnvironment.CHATTICUS_SMOKE_COMPUTER = smokeComputer;
    }

    taskDefinition.addContainer("computer", {
      image: ecs.ContainerImage.fromEcrRepository(repository, "dev"),
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: "computer",
      }),
      environment: computerEnvironment,
    });

    const securityGroup = new ec2.SecurityGroup(this, "ComputerSecurityGroup", {
      vpc,
      description: "Computer hosts: egress only. No inbound ports.",
      allowAllOutbound: true,
    });

    const service = new ecs.FargateService(this, "FargateHost", {
      cluster,
      taskDefinition,
      desiredCount: Number.isFinite(computerCount) ? computerCount : 0,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [securityGroup],
      circuitBreaker: { rollback: true },
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      enableExecuteCommand: true,
    });

    new cdk.CfnOutput(this, "ComputerRepositoryUri", {
      value: repository.repositoryUri,
    });
    new cdk.CfnOutput(this, "ComputerClusterName", {
      value: cluster.clusterName,
    });
    new cdk.CfnOutput(this, "ComputerTaskDefinitionArn", {
      value: taskDefinition.taskDefinitionArn,
    });
    new cdk.CfnOutput(this, "ComputerServiceName", {
      value: service.serviceName,
    });
  }
}
