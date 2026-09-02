import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TRUSTED_DEVELOPMENT_WORKFLOW_REFS,
  TRUSTED_PRODUCTION_WORKFLOW_REFS,
  TRUSTED_STAGING_WORKFLOW_REFS,
} from "../lib/github-deploy-stack";
import {
  federatedPrincipalConditions,
  roleAssumeRolePolicy,
  synthGitHubDeployStack,
} from "./github-deploy-stack-harness";

function stringLikeWorkflowRefs(condition: Record<string, unknown>): string[] {
  const stringLike = condition.StringLike as Record<string, string[]>;
  return stringLike["token.actions.githubusercontent.com:job_workflow_ref"];
}

function environmentClaim(condition: Record<string, unknown>): string {
  const stringEquals = condition.StringEquals as Record<string, string>;
  return stringEquals["token.actions.githubusercontent.com:environment"];
}

describe("GitHubDeployStack", () => {
  const template = synthGitHubDeployStack();

  it("creates development, staging, and production deploy roles", () => {
    template.resourceCountIs("AWS::IAM::Role", 3);
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "chatticus-github-actions-deploy",
    });
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "chatticus-github-actions-deploy-staging",
    });
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "chatticus-github-actions-deploy-production",
    });
  });

  it("trusts development workflows only on the development role", () => {
    const condition = federatedPrincipalConditions(
      roleAssumeRolePolicy(template, "chatticus-github-actions-deploy"),
    );
    assert.equal(environmentClaim(condition), "development");
    assert.deepEqual(
      stringLikeWorkflowRefs(condition),
      [...TRUSTED_DEVELOPMENT_WORKFLOW_REFS],
    );
  });

  it("trusts staging workflows only on the staging role", () => {
    const condition = federatedPrincipalConditions(
      roleAssumeRolePolicy(template, "chatticus-github-actions-deploy-staging"),
    );
    assert.equal(environmentClaim(condition), "staging");
    assert.deepEqual(stringLikeWorkflowRefs(condition), [...TRUSTED_STAGING_WORKFLOW_REFS]);
  });

  it("trusts production workflows only on the production role", () => {
    const condition = federatedPrincipalConditions(
      roleAssumeRolePolicy(template, "chatticus-github-actions-deploy-production"),
    );
    assert.equal(environmentClaim(condition), "production");
    assert.deepEqual(
      stringLikeWorkflowRefs(condition),
      [...TRUSTED_PRODUCTION_WORKFLOW_REFS],
    );
  });

  it("does not cross-trust staging or production workflow paths on development", () => {
    const condition = federatedPrincipalConditions(
      roleAssumeRolePolicy(template, "chatticus-github-actions-deploy"),
    );
    const trusted = stringLikeWorkflowRefs(condition);
    for (const workflowRef of [
      ...TRUSTED_STAGING_WORKFLOW_REFS,
      ...TRUSTED_PRODUCTION_WORKFLOW_REFS,
    ]) {
      assert.equal(
        trusted.includes(workflowRef),
        false,
        `development role must not trust ${workflowRef}`,
      );
    }
  });
});
