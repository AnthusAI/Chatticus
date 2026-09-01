import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

/** GitHub repository slug for OIDC trust (not an AWS account id). */
const GITHUB_REPOSITORY = "AnthusAI/Chattic.us";

/** Development deploy workflows trusted for OIDC AssumeRole (explicit list). */
const TRUSTED_DEVELOPMENT_WORKFLOW_REFS = [
  `${GITHUB_REPOSITORY}/.github/workflows/deploy-thinturn-development.yml@*`,
  `${GITHUB_REPOSITORY}/.github/workflows/deploy-web-development.yml@*`,
] as const;

/**
 * IAM role GitHub Actions assumes via OIDC for CDK deploy workflows.
 *
 * Trusts **Deploy ThinTurn (development)** and **Deploy Web (development)**
 * on the `development` GitHub environment. The role is broad enough for CDK
 * deploy of ChatticusThinTurn / ChatticusWeb and read-only lookups of
 * ChatticusComputers outputs used by the development deploy scripts.
 */
export class GitHubDeployStack extends cdk.Stack {
  public readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const githubProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      "GitHubOidc",
      `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
    );

    this.deployRole = new iam.Role(this, "GithubActionsDeploy", {
      roleName: "chatticus-github-actions-deploy",
      description:
        "GitHub Actions OIDC deploy: development ThinTurn and Web workflows.",
      assumedBy: new iam.WebIdentityPrincipal(
        githubProvider.openIdConnectProviderArn,
        {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:environment": "development",
          },
          StringLike: {
            "token.actions.githubusercontent.com:job_workflow_ref":
              TRUSTED_DEVELOPMENT_WORKFLOW_REFS,
          },
        },
      ),
    });
    this.deployRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AdministratorAccess"),
    );

    new cdk.CfnOutput(this, "GithubDeployRoleArn", {
      value: this.deployRole.roleArn,
      description:
        "Set GitHub environment secret AWS_DEPLOY_ROLE_ARN (development) to this value.",
    });
    new cdk.CfnOutput(this, "GithubDeployRoleName", {
      value: this.deployRole.roleName,
    });
    new cdk.CfnOutput(this, "TrustedWorkflows", {
      value: TRUSTED_DEVELOPMENT_WORKFLOW_REFS.join(", "),
      description: "job_workflow_ref patterns trusted for AssumeRoleWithWebIdentity.",
    });
  }
}
