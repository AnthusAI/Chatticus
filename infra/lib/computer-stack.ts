import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { COMPUTER_IMAGE_TAGS, COMPUTERS_STACK_IDS, type ChatticusCloudEnvironment } from "./environments";
import { CHATTICUS_LOG_RETENTION } from "./log-retention";

/**
 * Task definition family of the Pi session owner task of one environment. A
 * family is an account-wide name and all three environments share one account,
 * so development and staging each get a suffixed family. Production keeps the
 * unsuffixed name its Computers stack has always used.
 */
export function ownerTaskDefinitionFamily(environment: ChatticusCloudEnvironment): string {
  switch (environment) {
    case "development":
      return "ChatticusComputerOwnerDevelopment";
    case "staging":
      return "ChatticusComputerOwnerStaging";
    case "production":
      return "ChatticusComputerOwner";
  }
}

/**
 * CloudFormation names the computer ECR repository
 * `<stack name>-<logical id><hash>-<suffix>` in lower case. The deploy role
 * that pushes the image cannot know the full name before the stack exists, so
 * it is scoped to this prefix inside its own account. Each environment's prefix
 * starts with its own Computers stack name, so one environment's prefix never
 * matches another's repository. A test pins the prefix to the synthesized
 * logical id.
 */
export function computerRepositoryNamePrefix(environment: ChatticusCloudEnvironment): string {
  return `${COMPUTERS_STACK_IDS[environment].toLowerCase()}-computerimage`;
}

/** Seconds ECS waits after SIGTERM before it kills the owner container: room for the supervisor to stop its child, publish the final snapshot and report stopped. */
export const OWNER_CONTAINER_STOP_TIMEOUT_SECONDS = 90;

export interface ComputerStackProps extends cdk.StackProps {
  chatticusEnvironment: ChatticusCloudEnvironment;
  snapshotBucket: s3.IBucket;
}

/**
 * Fargate-capable computer owner. The workplace image is stored in ECR.
 *
 * There is no always-defined service: the control plane starts the owner task on
 * demand with RunTask. v1 AWS computers are Fargate ARM64 so the same image runs
 * on Apple Silicon Docker and Fargate. Optional stop/start EC2 is later, for a
 * warm EBS cache.
 *
 * The one task definition, the owner, runs the image under an init process with
 * a task role that has no policies at all. The supervisor in the container
 * receives its credentials from the credential broker, never from the task role;
 * see ``wireComputerStarterOwnerRunTask``. The stack exports the cluster, subnets
 * and security group the starter runs the task in.
 */
export class ComputerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ComputerStackProps) {
    super(scope, id, props);

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

    const logGroup = new logs.LogGroup(this, "ComputerLogs", {
      retention: CHATTICUS_LOG_RETENTION,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const computerEnvironment: { [key: string]: string } = {
      CHATTICUS_SNAPSHOT_BUCKET: props.snapshotBucket.bucketName,
      CHATTICUS_LIVE_ROOT: "/var/lib/chatticus/computer",
      CHATTICUS_TENANT_ID: "anthus",
    };
    if (smokeComputer !== "") {
      computerEnvironment.CHATTICUS_SMOKE_COMPUTER = smokeComputer;
    }

    const ownerTaskRole = new iam.Role(this, "ComputerOwnerTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description:
        "Pi session owner task: deliberately empty. The shell in the container can reach the task credentials endpoint, so this role can do nothing.",
    });

    const ownerTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      "ComputerOwnerTask",
      {
        family: ownerTaskDefinitionFamily(props.chatticusEnvironment),
        cpu: 256,
        memoryLimitMiB: 512,
        taskRole: ownerTaskRole,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.ARM64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      },
    );
    ownerTaskDefinition.addContainer("computer", {
      image: ecs.ContainerImage.fromEcrRepository(
        repository,
        COMPUTER_IMAGE_TAGS[props.chatticusEnvironment],
      ),
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: "computer-owner",
      }),
      environment: computerEnvironment,
      linuxParameters: new ecs.LinuxParameters(this, "ComputerOwnerLinuxParameters", {
        initProcessEnabled: true,
      }),
      stopTimeout: cdk.Duration.seconds(OWNER_CONTAINER_STOP_TIMEOUT_SECONDS),
    });

    const securityGroup = new ec2.SecurityGroup(this, "ComputerSecurityGroup", {
      vpc,
      description: "Computer hosts: egress only. No inbound ports.",
      allowAllOutbound: true,
    });

    new cdk.CfnOutput(this, "ComputerRepositoryUri", {
      value: repository.repositoryUri,
    });
    new cdk.CfnOutput(this, "ComputerClusterName", {
      value: cluster.clusterName,
    });
    new cdk.CfnOutput(this, "ComputerSubnetIds", {
      value: cdk.Fn.join(",", vpc.publicSubnets.map((subnet) => subnet.subnetId)),
    });
    new cdk.CfnOutput(this, "ComputerSecurityGroupId", {
      value: securityGroup.securityGroupId,
    });
    new cdk.CfnOutput(this, "ComputerOwnerTaskDefinitionArn", {
      value: ownerTaskDefinition.taskDefinitionArn,
    });
    new cdk.CfnOutput(this, "ComputerOwnerTaskRoleArn", {
      value: ownerTaskRole.roleArn,
    });
    new cdk.CfnOutput(this, "ComputerOwnerExecutionRoleArn", {
      value: ownerTaskDefinition.obtainExecutionRole().roleArn,
    });
    new cdk.CfnOutput(this, "ComputerSnapshotBucketName", {
      value: props.snapshotBucket.bucketName,
    });
  }
}
