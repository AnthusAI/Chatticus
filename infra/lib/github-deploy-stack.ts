import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

/** GitHub repository slug for OIDC trust (not an AWS account id). */
const GITHUB_REPOSITORY = "AnthusAI/Chatticus";

/**
 * GitHub's OIDC `sub` claim for this repo, e.g.:
 *   repo:AnthusAI@152415604/Chattic.us@1350947261:environment:development
 *
 * GitHub appends immutable numeric owner/repo IDs to the `sub` claim
 * (`OWNER@ownerId/REPO@repoId` instead of plain `OWNER/REPO`), and those ids
 * are fixed for as long as this repo isn't deleted/transferred -- but the
 * *name* segments (`AnthusAI`, `Chattic.us`) are the repo's current display
 * name at token-mint time, and change immediately on a `gh repo rename`.
 * Trust is therefore matched with `StringLike` wildcards over the name
 * segments, pinned only by the numeric ids, so a rename (e.g. to
 * `AnthusAI/Chatticus`) does not invalidate every deploy role in one motion.
 */
const GITHUB_SUB_PREFIX = "repo:*@152415604/*@1350947261";

/**
 * Development deploy workflows this role is intended to back (documentation
 * only -- see the trust-condition comment on `createGithubDeployRole` for
 * why these aren't the actual IAM trust-policy condition).
 */
const TRUSTED_DEVELOPMENT_WORKFLOW_REFS = [
  `${GITHUB_REPOSITORY}/.github/workflows/deploy-thinturn-development.yml@*`,
  `${GITHUB_REPOSITORY}/.github/workflows/deploy-web-development.yml@*`,
  `${GITHUB_REPOSITORY}/.github/workflows/deploy-auth-development.yml@*`,
] as const;

/** Staging deploy workflows this role is intended to back (documentation only). */
const TRUSTED_STAGING_WORKFLOW_REFS = [
  `${GITHUB_REPOSITORY}/.github/workflows/deploy-thinturn-staging.yml@*`,
  `${GITHUB_REPOSITORY}/.github/workflows/deploy-web-staging.yml@*`,
  `${GITHUB_REPOSITORY}/.github/workflows/deploy-auth-staging.yml@*`,
] as const;

/** Production deploy workflows this role is intended to back (documentation only). */
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
): iam.Role {
  const role = new iam.Role(scope, id, {
    roleName,
    description,
    // Trust is scoped by the `sub` claim (repo identity + GitHub
    // environment name), NOT by `job_workflow_ref` or `environment` as
    // separate condition keys.
    //
    // Root-caused 2026-09-03: every push- and workflow_dispatch-triggered
    // run of these deploy workflows failed at "Configure AWS credentials"
    // with "Not authorized to perform sts:AssumeRoleWithWebIdentity", even
    // though CloudTrail showed the request reaching AWS with the correct
    // `aud` and a `sub` that plainly satisfied the intended scope. A
    // decoded-claims debug step (temporary workflow step, since removed)
    // confirmed the OIDC ID token's `aud`, `environment`, and
    // `job_workflow_ref` claims all matched the trust policy's
    // StringEquals/StringLike conditions byte-for-byte -- yet
    // AssumeRoleWithWebIdentity was still denied. Swapping the trust
    // condition to StringLike on `sub` alone (same account, same role,
    // only the condition key changed) succeeded immediately; a control
    // test using only `job_workflow_ref` (dropping `environment`) still
    // failed. So in this account, this OIDC provider does not evaluate the
    // `token.actions.githubusercontent.com:environment` or
    // `:job_workflow_ref` custom claim condition keys as documented --
    // only `aud` and `sub` are honored. Trust is therefore scoped via
    // `sub`, matched against the fixed owner/repo ID prefix plus the
    // GitHub environment name; this still gives per-environment isolation
    // (development/staging/production can't assume each other's role),
    // just not per-workflow-file isolation within an environment.
    assumedBy: new iam.WebIdentityPrincipal(githubProvider.openIdConnectProviderArn, {
      StringEquals: {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      },
      StringLike: {
        "token.actions.githubusercontent.com:sub": `${GITHUB_SUB_PREFIX}:environment:${githubEnvironment}`,
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
 * assume a dedicated role whose trust condition matches that GitHub
 * environment's OIDC `sub` claim only (see `createGithubDeployRole` for why
 * `job_workflow_ref`/`environment` condition keys don't work here).
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
    );

    this.stagingDeployRole = createGithubDeployRole(
      this,
      "GithubActionsDeployStaging",
      "chatticus-github-actions-deploy-staging",
      "GitHub Actions OIDC deploy: staging ThinTurn, Web, and Auth workflows.",
      githubProvider,
      "staging",
    );

    this.productionDeployRole = createGithubDeployRole(
      this,
      "GithubActionsDeployProduction",
      "chatticus-github-actions-deploy-production",
      "GitHub Actions OIDC deploy: production ThinTurn, Web, and Auth workflows.",
      githubProvider,
      "production",
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
        "development workflows this role backs (informational -- trust is scoped by `sub`, not job_workflow_ref).",
    });
    new cdk.CfnOutput(this, "TrustedStagingWorkflows", {
      value: TRUSTED_STAGING_WORKFLOW_REFS.join(", "),
      description:
        "staging workflows this role backs (informational -- trust is scoped by `sub`, not job_workflow_ref).",
    });
    new cdk.CfnOutput(this, "TrustedProductionWorkflows", {
      value: TRUSTED_PRODUCTION_WORKFLOW_REFS.join(", "),
      description:
        "production workflows this role backs (informational -- trust is scoped by `sub`, not job_workflow_ref).",
    });
  }
}

export {
  TRUSTED_DEVELOPMENT_WORKFLOW_REFS,
  TRUSTED_PRODUCTION_WORKFLOW_REFS,
  TRUSTED_STAGING_WORKFLOW_REFS,
};
