import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import {
  ACCOUNT_DEPLOY_CREATES_OIDC_PROVIDER,
  ACCOUNT_DEPLOY_ROLE_NAMES,
  peerEnvironmentsInSameAccount,
  stackIdsOfEnvironment,
  webParameterPrefix,
  thinTurnParameterPrefix,
  integrationTestParameterPrefix,
  invokeKeySecretArnParameterName,
  type ChatticusCloudEnvironment,
} from "./environments";
import { createGithubDeployRole, GITHUB_SUB_PREFIX, type GithubDeployEnvironment } from "./github-deploy-stack";
import { TAG_ENVIRONMENT } from "./tagging";

export const GITHUB_OIDC_PROVIDER_URL = "token.actions.githubusercontent.com";

/**
 * Environments that have a GitHub OIDC integration test principal. Production
 * never has one.
 */
export const INTEGRATION_TEST_ENVIRONMENTS: readonly GithubDeployEnvironment[] = ["development", "staging"];

export function integrationTestRoleName(environment: GithubDeployEnvironment): string {
  return `chatticus-github-actions-integration-test-${environment}`;
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
 * All three environments share one account. Production's stack was there
 * first: it creates the OIDC provider (as it always has), and development's and
 * staging's stacks import it by ARN, so they can only be deployed after
 * production's. Each environment's role also gets the explicit denies that keep
 * it away from the other two environments' stacks, parameters and tagged
 * resources.
 * The legacy account keeps the three-role GitHubDeployStack until it is retired.
 */
export class AccountGitHubDeployStack extends cdk.Stack {
  public readonly deployRole: iam.Role;
  public readonly integrationTestRole?: iam.Role;

  constructor(scope: Construct, id: string, props: AccountGitHubDeployStackProps) {
    super(scope, id, props);

    const peers = peerEnvironmentsInSameAccount(props.githubEnvironment);
    const providerArn =
      ACCOUNT_DEPLOY_CREATES_OIDC_PROVIDER[props.githubEnvironment]
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

    for (const statement of peerEnvironmentDenyStatements(this, peers)) {
      this.deployRole.addToPolicy(statement);
    }

    if (INTEGRATION_TEST_ENVIRONMENTS.includes(props.githubEnvironment)) {
      this.integrationTestRole = this.createIntegrationTestRole(
        providerArn,
        props.githubEnvironment,
        integrationTestRoleName(props.githubEnvironment),
      );
    }

    new cdk.CfnOutput(this, "GithubDeployRoleArn", {
      value: this.deployRole.roleArn,
      description: `Environment secret AWS_DEPLOY_ROLE_ARN for the ${props.githubEnvironment} GitHub environment, set only at cutover.`,
    });
  }

  /**
   * The principal the post-deploy acceptance smoke test runs as: assumed through
   * GitHub OIDC by its own environment only (development or staging, never production), with read access to the two
   * thin-turn parameters the acceptance runner resolves and to the invoke-key
   * secret they point to, and nothing else. Its ARN is the value of the
   * CHATTICUS_INTEGRATION_TEST_ALLOWED_ROLE_ARN GitHub environment variable and
   * of the control plane's integration-test allowed-role parameter.
   */
  private createIntegrationTestRole(
    providerArn: string,
    environment: GithubDeployEnvironment,
    roleName: string,
  ): iam.Role {
    const role = new iam.Role(this, "GithubActionsIntegrationTest", {
      roleName,
      description: `GitHub Actions OIDC: ${environment} acceptance smoke test (integration-test session exchange).`,
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(providerArn, {
        StringEquals: { [`${GITHUB_OIDC_PROVIDER_URL}:aud`]: "sts.amazonaws.com" },
        StringLike: { [`${GITHUB_OIDC_PROVIDER_URL}:sub`]: `${GITHUB_SUB_PREFIX}:environment:${environment}` },
      }),
    });
    const thinTurnPrefix = thinTurnParameterPrefix(environment);
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [`${thinTurnPrefix}/cloudfront-url`, invokeKeySecretArnParameterName(environment)].map(
          (name) =>
            this.formatArn({ service: "ssm", resource: "parameter", resourceName: name.slice(1) }),
        ),
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [
          ssm.StringParameter.valueForStringParameter(this, invokeKeySecretArnParameterName(environment)),
        ],
      }),
    );
    new cdk.CfnOutput(this, "IntegrationTestRoleArn", {
      value: role.roleArn,
      description: `Value for the CHATTICUS_INTEGRATION_TEST_ALLOWED_ROLE_ARN variable of the ${environment} GitHub environment.`,
    });
    return role;
  }
}
