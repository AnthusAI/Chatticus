import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { CHATTICUS_LOG_RETENTION } from "./log-retention";

export interface CustomerComputersStackProps extends cdk.StackProps {}

/**
 * Customer-account ChatticusComputers stack: Fargate host wiring with a
 * customer-owned ECR repository. RunTask pulls :dev from the organization
 * AWS home only.
 */
export class CustomerComputersStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: CustomerComputersStackProps) {
    super(scope, id, {
      ...props,
      synthesizer: props?.synthesizer ?? new cdk.BootstraplessSynthesizer(),
    });

    const tenantId = new cdk.CfnParameter(this, "TenantId", {
      type: "String",
      description: "Chatticus organization tenant id.",
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
      image: ecs.ContainerImage.fromEcrRepository(repository, "dev"),
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: "computer",
      }),
      environment: {
        CHATTICUS_LIVE_ROOT: "/var/lib/chatticus/computer",
        CHATTICUS_TENANT_ID: tenantId.valueAsString,
      },
    });

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
    new cdk.CfnOutput(this, "ComputerPublicSubnetIds", {
      value: cdk.Fn.join(",", vpc.publicSubnets.map((subnet) => subnet.subnetId)),
    });
    new cdk.CfnOutput(this, "ComputerSecurityGroupId", {
      value: securityGroup.securityGroupId,
    });
  }
}
