import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { createGithubDeployRole, type GithubDeployEnvironment } from "./github-deploy-stack";

export const ACCOUNT_DEPLOY_ROLE_NAME = "chatticus-github-actions-deploy";

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

    new cdk.CfnOutput(this, "GithubDeployRoleArn", {
      value: this.deployRole.roleArn,
      description: `Environment secret AWS_DEPLOY_ROLE_ARN for the ${props.githubEnvironment} GitHub environment, set only at cutover.`,
    });
  }
}
