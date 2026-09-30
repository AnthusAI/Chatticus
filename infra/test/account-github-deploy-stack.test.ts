import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { ACCOUNT_DEPLOY_ROLE_NAME, AccountGitHubDeployStack } from "../lib/account-github-deploy-stack";
import { CHATTICUS_CLOUD_ENVIRONMENTS } from "../lib/environments";
import { federatedPrincipalConditions, roleAssumeRolePolicy } from "./github-deploy-stack-harness";

const GITHUB_SUB_PREFIX = "repo:*@152415604/*@1350947261";

function synth(environment: (typeof CHATTICUS_CLOUD_ENVIRONMENTS)[number]): Template {
  const app = new cdk.App();
  const stack = new AccountGitHubDeployStack(app, "ChatticusAccountDeploy", {
    env: { account: "222222222222", region: "us-east-1" },
    githubEnvironment: environment,
  });
  return Template.fromStack(stack);
}

describe("AccountGitHubDeployStack", () => {
  for (const environment of CHATTICUS_CLOUD_ENVIRONMENTS) {
    describe(environment, () => {
      const template = synth(environment);

      it("creates the GitHub OIDC provider, since a new account has none", () => {
        template.resourceCountIs("AWS::IAM::OIDCProvider", 1);
        template.hasResourceProperties("AWS::IAM::OIDCProvider", {
          Url: "https://token.actions.githubusercontent.com",
          ClientIdList: ["sts.amazonaws.com"],
        });
      });

      it("creates exactly one deploy role, not one per environment", () => {
        template.resourceCountIs("AWS::IAM::Role", 1);
        template.hasResourceProperties("AWS::IAM::Role", { RoleName: ACCOUNT_DEPLOY_ROLE_NAME });
      });

      it("trusts only this environment's sub claim, pinned to the repository ids", () => {
        const condition = federatedPrincipalConditions(roleAssumeRolePolicy(template, ACCOUNT_DEPLOY_ROLE_NAME));
        const audience = (condition.StringEquals as Record<string, string>)["token.actions.githubusercontent.com:aud"];
        const subject = (condition.StringLike as Record<string, string>)["token.actions.githubusercontent.com:sub"];
        assert.equal(audience, "sts.amazonaws.com");
        assert.equal(subject, `${GITHUB_SUB_PREFIX}:environment:${environment}`);
        for (const other of CHATTICUS_CLOUD_ENVIRONMENTS.filter((name) => name !== environment)) {
          assert.notEqual(subject, `${GITHUB_SUB_PREFIX}:environment:${other}`);
        }
      });

      it("federates through the provider it creates in this account", () => {
        const policy = roleAssumeRolePolicy(template, ACCOUNT_DEPLOY_ROLE_NAME);
        const statement = (policy.Statement as Array<{ Principal: { Federated: { Ref: string } } }>)[0];
        const providerIds = Object.keys(template.findResources("AWS::IAM::OIDCProvider"));
        assert.deepEqual(statement.Principal.Federated, { Ref: providerIds[0] });
      });

      it("outputs the role ARN for the cutover step", () => {
        assert.ok("GithubDeployRoleArn" in template.toJSON().Outputs);
      });
    });
  }
});

describe("verify-account-deploy-role workflow", () => {
  const contents = readFileSync(
    join(__dirname, "..", "..", ".github", "workflows", "verify-account-deploy-role.yml"),
    "utf8",
  );

  it("only runs by hand, never on a push or pull request (this repository is public)", () => {
    assert.match(contents, /^on:\n  workflow_dispatch:/m);
    assert.doesNotMatch(contents, /^\s+(push|pull_request|pull_request_target|schedule):/m);
  });

  it("reads the role from a masked environment secret, not from an input or the live deploy secret", () => {
    assert.match(contents, /role-to-assume: \$\{\{ secrets\.AWS_NEW_ACCOUNT_DEPLOY_ROLE_ARN \}\}/);
    assert.doesNotMatch(contents, /role_arn/);
    assert.doesNotMatch(contents, /secrets\.AWS_DEPLOY_ROLE_ARN/);
  });

  it("never interpolates an input into a shell step and never prints identities", () => {
    const runBlocks = contents.split(/\n\s+run: /).slice(1).join("\n");
    assert.doesNotMatch(runBlocks, /\$\{\{/);
    assert.doesNotMatch(contents, /get-caller-identity[^\n]*(Arn|--output text)(?![^\n]*> \/dev\/null)/);
  });

  it("authenticates with GitHub OIDC only", () => {
    assert.match(contents, /id-token:\s*write/);
    assert.doesNotMatch(contents, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/);
  });
});
