import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

/** GitHub repository slug for OIDC trust (not an AWS account id). */
const GITHUB_REPOSITORY = "AnthusAI/Chattic.us";

/**
 * IAM role GitHub Actions assumes via OIDC for CDK deploy workflows.
 *
 * Phase 1 trusts only **Deploy ThinTurn (development)** on the
 * `development` GitHub environment. The role is broad enough for CDK
 * deploy of ChatticusThinTurn and read-only lookups of ChatticusComputers
 * outputs used by the development deploy script.
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

    const thinTurnDevelopmentWorkflowRef = `${GITHUB_REPOSITORY}/.github/workflows/deploy-thinturn-development.yml@*`;

    this.deployRole = new iam.Role(this, "GithubActionsDeploy", {
      roleName: "chatticus-github-actions-deploy",
      description:
        "GitHub Actions OIDC deploy: phase-1 development ThinTurn workflow only.",
      assumedBy: new iam.WebIdentityPrincipal(
        githubProvider.openIdConnectProviderArn,
        {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:environment": "development",
          },
          StringLike: {
            "token.actions.githubusercontent.com:job_workflow_ref":
              thinTurnDevelopmentWorkflowRef,
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
    new cdk.CfnOutput(this, "TrustedWorkflow", {
      value: thinTurnDevelopmentWorkflowRef,
      description: "job_workflow_ref pattern trusted for AssumeRoleWithWebIdentity.",
    });
  }
}
