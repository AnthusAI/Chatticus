import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { COMPUTER_REPOSITORY_NAME_PREFIX } from "./computer-stack";
import { createGithubDeployRole, type GithubDeployEnvironment } from "./github-deploy-stack";

export const ACCOUNT_DEPLOY_ROLE_NAME = "chatticus-github-actions-deploy";

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
function grantComputerImagePublish(stack: cdk.Stack, role: iam.Role): void {
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
          resourceName: `${COMPUTER_REPOSITORY_NAME_PREFIX}*`,
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
          resourceName: "ChatticusComputers/*",
        }),
      ],
    }),
  );
}

export interface AccountGitHubDeployStackProps extends cdk.StackProps {
  githubEnvironment: GithubDeployEnvironment;
}

/**
 * GitHub OIDC trust for one dedicated environment account: the provider
 * (created here, since a new account has none) and the single deploy role for
 * that account's own GitHub environment. The legacy account keeps the
 * three-role GitHubDeployStack until it is retired.
 */
export class AccountGitHubDeployStack extends cdk.Stack {
  public readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props: AccountGitHubDeployStackProps) {
    super(scope, id, props);

    const provider = new iam.OidcProviderNative(this, "GitHubOidc", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
    });

    this.deployRole = createGithubDeployRole(
      this,
      "GithubActionsDeploy",
      ACCOUNT_DEPLOY_ROLE_NAME,
      `GitHub Actions OIDC deploy: ${props.githubEnvironment} environment of this account.`,
      provider.oidcProviderArn,
      props.githubEnvironment,
    );

    if (props.githubEnvironment === "development") {
      grantComputerImagePublish(this, this.deployRole);
    }

    new cdk.CfnOutput(this, "GithubDeployRoleArn", {
      value: this.deployRole.roleArn,
      description: `Environment secret AWS_DEPLOY_ROLE_ARN for the ${props.githubEnvironment} GitHub environment, set only at cutover.`,
    });
  }
}
