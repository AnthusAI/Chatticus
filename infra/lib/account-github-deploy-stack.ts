import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { computerRepositoryNamePrefix } from "./computer-stack";
import {
  ACCOUNT_DEPLOY_ROLE_NAMES,
  COMPUTERS_STACK_IDS,
  peerEnvironmentsInSameAccount,
  stackIdsOfEnvironment,
  webParameterPrefix,
  thinTurnParameterPrefix,
  integrationTestParameterPrefix,
  type ChatticusCloudEnvironment,
} from "./environments";
import { createGithubDeployRole, type GithubDeployEnvironment } from "./github-deploy-stack";
import { TAG_ENVIRONMENT } from "./tagging";

export const GITHUB_OIDC_PROVIDER_URL = "token.actions.githubusercontent.com";

export const COMPUTER_IMAGE_PUSH_ACTIONS = [
  "ecr:BatchCheckLayerAvailability",
  "ecr:BatchGetImage",
  "ecr:CompleteLayerUpload",
  "ecr:DescribeImages",
  "ecr:DescribeRepositories",
  "ecr:GetDownloadUrlForLayer",
  "ecr:InitiateLayerUpload",
  "ecr:PutImage",
  "ecr:UploadLayerPart",
] as const;

/**
 * Lets the development deploy role publish the computer image: the ECR login
 * token (account-wide by AWS design), the push actions on the Computers
 * repository of this account only, and a read of the Computers stack outputs.
 */
function grantComputerImagePublish(
  stack: cdk.Stack,
  role: iam.Role,
  environment: ChatticusCloudEnvironment,
): void {
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: "EcrLoginToken",
      actions: ["ecr:GetAuthorizationToken"],
      resources: ["*"],
    }),
  );
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: "ComputerImagePush",
      actions: [...COMPUTER_IMAGE_PUSH_ACTIONS],
      resources: [
        stack.formatArn({
          service: "ecr",
          resource: "repository",
          resourceName: `${computerRepositoryNamePrefix(environment)}*`,
        }),
      ],
    }),
  );
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: "ComputerStackOutputs",
      actions: ["cloudformation:DescribeStacks"],
      resources: [
        stack.formatArn({
          service: "cloudformation",
          resource: "stack",
          resourceName: `${COMPUTERS_STACK_IDS[environment]}/*`,
        }),
      ],
    }),
  );
}

export interface AccountGitHubDeployStackProps extends cdk.StackProps {
  githubEnvironment: GithubDeployEnvironment;
}

/**
 * Explicit denies that keep the deploy role of one environment out of the other
 * environments that share its AWS account: CloudFormation on their stacks, their
 * SSM parameter paths, and anything tagged with their environment. The cost
 * attribution tags (`chatticus:environment`) are applied to every resource of a
 * stack, so the tag deny reaches resources whose names carry no environment.
 */
function peerEnvironmentDenyStatements(
  stack: cdk.Stack,
  peers: readonly ChatticusCloudEnvironment[],
): iam.PolicyStatement[] {
  if (peers.length === 0) {
    return [];
  }
  const peerStackArns = peers.flatMap((peer) =>
    stackIdsOfEnvironment(peer).map((stackId) =>
      stack.formatArn({ service: "cloudformation", resource: "stack", resourceName: `${stackId}/*` }),
    ),
  );
  const peerParameterArns = peers.flatMap((peer) =>
    [webParameterPrefix(peer), thinTurnParameterPrefix(peer), integrationTestParameterPrefix(peer)].map(
      (prefix) =>
        stack.formatArn({
          service: "ssm",
          resource: "parameter",
          resourceName: `${prefix.slice(1)}/*`,
        }),
    ),
  );
  return [
    new iam.PolicyStatement({
      sid: "DenyPeerEnvironmentStacks",
      effect: iam.Effect.DENY,
      actions: ["cloudformation:*"],
      resources: peerStackArns,
    }),
    new iam.PolicyStatement({
      sid: "DenyPeerEnvironmentParameters",
      effect: iam.Effect.DENY,
      actions: ["ssm:*"],
      resources: peerParameterArns,
    }),
    new iam.PolicyStatement({
      sid: "DenyPeerEnvironmentTaggedResources",
      effect: iam.Effect.DENY,
      actions: ["*"],
      resources: ["*"],
      conditions: { StringEquals: { [`aws:ResourceTag/${TAG_ENVIRONMENT}`]: [...peers] } },
    }),
  ];
}

/**
 * GitHub OIDC trust for one environment: that environment's own deploy role,
 * named for the environment, trusting only that GitHub environment.
 *
 * Development lives in an account of its own, so its stack creates the OIDC
 * provider there. Staging and production share one account: the provider exists
 * once, created by the GitHubOidcProviderStack, and each of their stacks imports
 * it. A shared account also gets the explicit denies that keep each environment's
 * role away from the other environment's stacks, parameters and tagged resources.
 * The legacy account keeps the three-role GitHubDeployStack until it is retired.
 */
export class AccountGitHubDeployStack extends cdk.Stack {
  public readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props: AccountGitHubDeployStackProps) {
    super(scope, id, props);

    const peers = peerEnvironmentsInSameAccount(props.githubEnvironment);
    const providerArn =
      peers.length === 0
        ? new iam.OidcProviderNative(this, "GitHubOidc", {
            url: `https://${GITHUB_OIDC_PROVIDER_URL}`,
            clientIds: ["sts.amazonaws.com"],
          }).oidcProviderArn
        : iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
            this,
            "GitHubOidc",
            this.formatArn({
              service: "iam",
              region: "",
              resource: "oidc-provider",
              resourceName: GITHUB_OIDC_PROVIDER_URL,
            }),
          ).openIdConnectProviderArn;

    this.deployRole = createGithubDeployRole(
      this,
      "GithubActionsDeploy",
      ACCOUNT_DEPLOY_ROLE_NAMES[props.githubEnvironment],
      `GitHub Actions OIDC deploy: ${props.githubEnvironment} environment of this account.`,
      providerArn,
      props.githubEnvironment,
    );

    if (props.githubEnvironment === "development") {
      grantComputerImagePublish(this, this.deployRole, props.githubEnvironment);
    }

    for (const statement of peerEnvironmentDenyStatements(this, peers)) {
      this.deployRole.addToPolicy(statement);
    }

    new cdk.CfnOutput(this, "GithubDeployRoleArn", {
      value: this.deployRole.roleArn,
      description: `Environment secret AWS_DEPLOY_ROLE_ARN for the ${props.githubEnvironment} GitHub environment, set only at cutover.`,
    });
  }
}
