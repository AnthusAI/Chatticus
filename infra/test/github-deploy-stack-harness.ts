import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import {
  GitHubDeployStack,
  TRUSTED_DEVELOPMENT_WORKFLOW_REFS,
  TRUSTED_PRODUCTION_WORKFLOW_REFS,
  TRUSTED_STAGING_WORKFLOW_REFS,
} from "../lib/github-deploy-stack";

const testEnv = {
  account: "111111111111",
  region: "us-east-1",
};

export function synthGitHubDeployStack(): Template {
  const app = new cdk.App();
  const stack = new GitHubDeployStack(app, "ChatticusGitHubDeploy", {
    env: testEnv,
  });
  return Template.fromStack(stack);
}

export function roleAssumeRolePolicy(
  template: Template,
  roleName: string,
): Record<string, unknown> {
  const roles = template.findResources("AWS::IAM::Role");
  for (const resource of Object.values(roles)) {
    const properties = resource.Properties as { RoleName?: string; AssumeRolePolicyDocument?: unknown };
    if (properties.RoleName === roleName) {
      return properties.AssumeRolePolicyDocument as Record<string, unknown>;
    }
  }
  throw new Error(`IAM role not found: ${roleName}`);
}

export function federatedPrincipalConditions(
  assumeRolePolicy: Record<string, unknown>,
): Record<string, unknown> {
  const statements = assumeRolePolicy.Statement as Array<Record<string, unknown>>;
  const federated = statements.find(
    (statement) =>
      statement.Action === "sts:AssumeRoleWithWebIdentity" &&
      typeof statement.Principal === "object" &&
      statement.Principal !== null &&
      "Federated" in (statement.Principal as Record<string, unknown>),
  );
  if (!federated?.Condition) {
    throw new Error("missing Federated AssumeRoleWithWebIdentity condition");
  }
  return federated.Condition as Record<string, unknown>;
}
