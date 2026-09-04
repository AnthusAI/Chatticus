import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  federatedPrincipalConditions,
  roleAssumeRolePolicy,
  synthGitHubDeployStack,
} from "./github-deploy-stack-harness";

const GITHUB_SUB_PREFIX = "repo:*@152415604/*@1350947261";

function subClaim(condition: Record<string, unknown>): string {
  const stringLike = condition.StringLike as Record<string, string>;
  return stringLike["token.actions.githubusercontent.com:sub"];
}

function audClaim(condition: Record<string, unknown>): string {
  const stringEquals = condition.StringEquals as Record<string, string>;
  return stringEquals["token.actions.githubusercontent.com:aud"];
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

  // Trust is scoped by the `sub` claim (repo identity + GitHub environment
  // name), not by `job_workflow_ref`/`environment` condition keys -- AWS
  // STS does not evaluate those two custom claim keys for this OIDC
  // provider/account, confirmed 2026-09-03 (see the comment on
  // `createGithubDeployRole` in github-deploy-stack.ts for the full
  // root-cause narrative).
  it("trusts only the development environment's sub claim on the development role", () => {
    const condition = federatedPrincipalConditions(
      roleAssumeRolePolicy(template, "chatticus-github-actions-deploy"),
    );
    assert.equal(audClaim(condition), "sts.amazonaws.com");
    assert.equal(subClaim(condition), `${GITHUB_SUB_PREFIX}:environment:development`);
  });

  it("trusts only the staging environment's sub claim on the staging role", () => {
    const condition = federatedPrincipalConditions(
      roleAssumeRolePolicy(template, "chatticus-github-actions-deploy-staging"),
    );
    assert.equal(subClaim(condition), `${GITHUB_SUB_PREFIX}:environment:staging`);
  });

  it("trusts only the production environment's sub claim on the production role", () => {
    const condition = federatedPrincipalConditions(
      roleAssumeRolePolicy(template, "chatticus-github-actions-deploy-production"),
    );
    assert.equal(subClaim(condition), `${GITHUB_SUB_PREFIX}:environment:production`);
  });

  it("does not cross-trust staging or production environment claims on development", () => {
    const condition = federatedPrincipalConditions(
      roleAssumeRolePolicy(template, "chatticus-github-actions-deploy"),
    );
    const trusted = subClaim(condition);
    assert.notEqual(trusted, `${GITHUB_SUB_PREFIX}:environment:staging`);
    assert.notEqual(trusted, `${GITHUB_SUB_PREFIX}:environment:production`);
  });
});
