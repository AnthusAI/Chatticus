import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

/** GitHub repository slug for OIDC trust (not an AWS account id). */
const GITHUB_REPOSITORY = "AnthusAI/Chattic.us";

/** Development deploy workflows trusted for OIDC AssumeRole (explicit list). */
const TRUSTED_DEVELOPMENT_WORKFLOW_REFS = [
  `${GITHUB_REPOSITORY}/.github/workflows/deploy-thinturn-development.yml@*`,
  `${GITHUB_REPOSITORY}/.github/workflows/deploy-web-development.yml@*`,
  `${GITHUB_REPOSITORY}/.github/workflows/deploy-auth-development.yml@*`,
] as const;

/** Staging deploy workflows trusted for OIDC AssumeRole (explicit list). */
const TRUSTED_STAGING_WORKFLOW_REFS = [
  `${GITHUB_REPOSITORY}/.github/workflows/deploy-thinturn-staging.yml@*`,
  `${GITHUB_REPOSITORY}/.github/workflows/deploy-web-staging.yml@*`,
  `${GITHUB_REPOSITORY}/.github/workflows/deploy-auth-staging.yml@*`,
] as const;

/** Production deploy workflows trusted for OIDC AssumeRole (explicit list). */
const TRUSTED_PRODUCTION_WORKFLOW_REFS = [
  `${GITHUB_REPOSITORY}/.github/workflows/deploy-thinturn-production.yml@*`,
  `${GITHUB_REPOSITORY}/.github/workflows/deploy-web-production.yml@*`,
  `${GITHUB_REPOSITORY}/.github/workflows/deploy-auth-production.yml@*`,
] as const;

type GithubDeployEnvironment = "development" | "staging" | "production";

function createGithubDeployRole(
  scope: Construct,
  id: string,
  roleName: string,
  description: string,
  githubProvider: iam.IOpenIdConnectProvider,
  githubEnvironment: GithubDeployEnvironment,
  trustedWorkflowRefs: readonly string[],
): iam.Role {
  const role = new iam.Role(scope, id, {
    roleName,
    description,
    assumedBy: new iam.WebIdentityPrincipal(githubProvider.openIdConnectProviderArn, {
      StringEquals: {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:environment": githubEnvironment,
      },
      StringLike: {
        "token.actions.githubusercontent.com:job_workflow_ref": trustedWorkflowRefs,
      },
    }),
  });
  role.addManagedPolicy(
    iam.ManagedPolicy.fromAwsManagedPolicyName("AdministratorAccess"),
  );
  return role;
}

/**
 * IAM roles GitHub Actions assumes via OIDC for CDK deploy workflows.
 *
 * One AWS account hosts development, staging, and production named stacks.
 * Three GitHub environments (`development`, `staging`, `production`) each
 * assume a dedicated role whose trust list matches that environment's
 * workflow_dispatch deploy paths only.
 */
export class GitHubDeployStack extends cdk.Stack {
  public readonly deployRole: iam.Role;
  public readonly stagingDeployRole: iam.Role;
  public readonly productionDeployRole: iam.Role;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const githubProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      "GitHubOidc",
      `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
    );

    this.deployRole = createGithubDeployRole(
      this,
      "GithubActionsDeploy",
      "chatticus-github-actions-deploy",
      "GitHub Actions OIDC deploy: development ThinTurn, Web, and Auth workflows.",
      githubProvider,
      "development",
      TRUSTED_DEVELOPMENT_WORKFLOW_REFS,
    );

    this.stagingDeployRole = createGithubDeployRole(
      this,
      "GithubActionsDeployStaging",
      "chatticus-github-actions-deploy-staging",
      "GitHub Actions OIDC deploy: staging ThinTurn, Web, and Auth workflows.",
      githubProvider,
      "staging",
      TRUSTED_STAGING_WORKFLOW_REFS,
    );

    this.productionDeployRole = createGithubDeployRole(
      this,
      "GithubActionsDeployProduction",
      "chatticus-github-actions-deploy-production",
      "GitHub Actions OIDC deploy: production ThinTurn, Web, and Auth workflows.",
      githubProvider,
      "production",
      TRUSTED_PRODUCTION_WORKFLOW_REFS,
    );

    new cdk.CfnOutput(this, "GithubDeployRoleArn", {
      value: this.deployRole.roleArn,
      description:
        "Set GitHub environment secret AWS_DEPLOY_ROLE_ARN (development) to this value.",
    });
    new cdk.CfnOutput(this, "GithubDeployRoleName", {
      value: this.deployRole.roleName,
    });
    new cdk.CfnOutput(this, "GithubDeployStagingRoleArn", {
      value: this.stagingDeployRole.roleArn,
      description:
        "Set GitHub environment secret AWS_DEPLOY_ROLE_ARN (staging) to this value.",
    });
    new cdk.CfnOutput(this, "GithubDeployStagingRoleName", {
      value: this.stagingDeployRole.roleName,
    });
    new cdk.CfnOutput(this, "GithubDeployProductionRoleArn", {
      value: this.productionDeployRole.roleArn,
      description:
        "Set GitHub environment secret AWS_DEPLOY_ROLE_ARN (production) to this value.",
    });
    new cdk.CfnOutput(this, "GithubDeployProductionRoleName", {
      value: this.productionDeployRole.roleName,
    });
    new cdk.CfnOutput(this, "TrustedDevelopmentWorkflows", {
      value: TRUSTED_DEVELOPMENT_WORKFLOW_REFS.join(", "),
      description:
        "development job_workflow_ref patterns trusted for AssumeRoleWithWebIdentity.",
    });
    new cdk.CfnOutput(this, "TrustedStagingWorkflows", {
      value: TRUSTED_STAGING_WORKFLOW_REFS.join(", "),
      description:
        "staging job_workflow_ref patterns trusted for AssumeRoleWithWebIdentity.",
    });
    new cdk.CfnOutput(this, "TrustedProductionWorkflows", {
      value: TRUSTED_PRODUCTION_WORKFLOW_REFS.join(", "),
      description:
        "production job_workflow_ref patterns trusted for AssumeRoleWithWebIdentity.",
    });
  }
}

export {
  TRUSTED_DEVELOPMENT_WORKFLOW_REFS,
  TRUSTED_PRODUCTION_WORKFLOW_REFS,
  TRUSTED_STAGING_WORKFLOW_REFS,
};
