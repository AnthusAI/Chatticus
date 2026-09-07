import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { CHATTICUS_LOG_RETENTION } from "./log-retention";

export interface CustomerComputersStackProps extends cdk.StackProps {}

/**
 * Customer-account ChatticusComputers stack: Fargate host wiring without a
 * snapshot bucket or customer ECR. The container image is pulled from Anthus
 * ECR at RunTask time.
 */
export class CustomerComputersStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: CustomerComputersStackProps) {
    super(scope, id, props);

    const tenantId = new cdk.CfnParameter(this, "TenantId", {
      type: "String",
      description: "Chatticus organization tenant id.",
    });

    const anthusComputerImageUri = new cdk.CfnParameter(this, "AnthusComputerImageUri", {
      type: "String",
      description: "Anthus ChatticusComputers ECR image URI for tag :dev.",
    });

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

    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
    });

    const taskRole = new iam.Role(this, "ComputerTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "Customer computer host task role (ephemeral live root only).",
    });

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

    taskDefinition.addContainer("computer", {
      image: ecs.ContainerImage.fromRegistry(anthusComputerImageUri.valueAsString),
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: "computer",
      }),
      environment: {
        CHATTICUS_LIVE_ROOT: "/var/lib/chatticus/computer",
        CHATTICUS_TENANT_ID: tenantId.valueAsString,
      },
    });

    const executionRole = taskDefinition.executionRole;
    if (executionRole === undefined) {
      throw new Error("Customer computer task definition must have an execution role.");
    }
    executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:GetAuthorizationToken",
          "ecr:GetDownloadUrlForLayer",
        ],
        resources: ["*"],
      }),
    );

    const securityGroup = new ec2.SecurityGroup(this, "ComputerSecurityGroup", {
      vpc,
      description: "Computer hosts: egress only. No inbound ports.",
      allowAllOutbound: true,
    });

    const service = new ecs.FargateService(this, "FargateHost", {
      cluster,
      taskDefinition,
      desiredCount: 0,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [securityGroup],
      circuitBreaker: { rollback: true },
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      enableExecuteCommand: true,
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
