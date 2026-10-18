import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AccountGitHubDeployStack, INTEGRATION_TEST_ROLE_NAME } from "../lib/account-github-deploy-stack";
import {
  ACCOUNT_DEPLOY_CREATES_OIDC_PROVIDER,
  ACCOUNT_DEPLOY_ROLE_NAMES,
  ACCOUNT_DEPLOY_STACK_IDS,
  CHATTICUS_CLOUD_ENVIRONMENTS,
} from "../lib/environments";
import { federatedPrincipalConditions, roleAssumeRolePolicy } from "./github-deploy-stack-harness";

import { GITHUB_SUB_PREFIX } from "../lib/github-deploy-stack";

function synth(environment: (typeof CHATTICUS_CLOUD_ENVIRONMENTS)[number]): Template {
  const app = new cdk.App();
  const stack = new AccountGitHubDeployStack(app, ACCOUNT_DEPLOY_STACK_IDS[environment], {
    env: { account: "222222222222", region: "us-east-1" },
    githubEnvironment: environment,
  });
  return Template.fromStack(stack);
}

describe("AccountGitHubDeployStack", () => {
  for (const environment of CHATTICUS_CLOUD_ENVIRONMENTS) {
    describe(environment, () => {
      const template = synth(environment);

      if (ACCOUNT_DEPLOY_CREATES_OIDC_PROVIDER[environment]) {
        it("creates the GitHub OIDC provider of its account", () => {
          template.resourceCountIs("AWS::IAM::OIDCProvider", 1);
          template.hasResourceProperties("AWS::IAM::OIDCProvider", {
            Url: "https://token.actions.githubusercontent.com",
            ClientIdList: ["sts.amazonaws.com"],
          });
        });
      } else {
        it("imports the account's GitHub OIDC provider, created by production's deploy stack, instead of creating a second", () => {
          template.resourceCountIs("AWS::IAM::OIDCProvider", 0);
          const policy = roleAssumeRolePolicy(template, ACCOUNT_DEPLOY_ROLE_NAMES[environment]);
          const federated = (policy.Statement as Array<{ Principal: { Federated: unknown } }>)[0].Principal.Federated;
          assert.match(JSON.stringify(federated), /oidc-provider\/token\.actions\.githubusercontent\.com/);
        });
      }

      it("creates exactly one deploy role, not one per environment, plus the integration test role in development only", () => {
        template.resourceCountIs("AWS::IAM::Role", environment === "development" ? 2 : 1);
        template.hasResourceProperties("AWS::IAM::Role", { RoleName: ACCOUNT_DEPLOY_ROLE_NAMES[environment] });
      });

      it("trusts only this environment's sub claim, pinned to the repository ids", () => {
        const condition = federatedPrincipalConditions(roleAssumeRolePolicy(template, ACCOUNT_DEPLOY_ROLE_NAMES[environment]));
        const audience = (condition.StringEquals as Record<string, string>)["token.actions.githubusercontent.com:aud"];
        const subject = (condition.StringLike as Record<string, string>)["token.actions.githubusercontent.com:sub"];
        assert.equal(audience, "sts.amazonaws.com");
        assert.equal(subject, `${GITHUB_SUB_PREFIX}:environment:${environment}`);
        for (const other of CHATTICUS_CLOUD_ENVIRONMENTS.filter((name) => name !== environment)) {
          assert.notEqual(subject, `${GITHUB_SUB_PREFIX}:environment:${other}`);
        }
      });

      it("federates through the provider it creates", { skip: !ACCOUNT_DEPLOY_CREATES_OIDC_PROVIDER[environment] }, () => {
        const policy = roleAssumeRolePolicy(template, ACCOUNT_DEPLOY_ROLE_NAMES[environment]);
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

describe("integration test role", () => {
  const template = synth("development");

  it("is trusted only by the development GitHub environment sub claim", () => {
    const condition = federatedPrincipalConditions(roleAssumeRolePolicy(template, INTEGRATION_TEST_ROLE_NAME));
    const subject = (condition.StringLike as Record<string, string>)["token.actions.githubusercontent.com:sub"];
    assert.equal(subject, `${GITHUB_SUB_PREFIX}:environment:development`);
  });

  it("can only read the two thin-turn parameters and the invoke key secret", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const statements = Object.values(policies)
      .filter((policy) => JSON.stringify(policy).includes("IntegrationTest"))
      .flatMap((policy) => (policy as any).Properties.PolicyDocument.Statement);
    assert.deepEqual(
      statements.flatMap((statement: any) => statement.Action).sort(),
      ["secretsmanager:GetSecretValue", "ssm:GetParameter"],
    );
  });

  for (const environment of ["staging", "production"] as const) {
    it(`does not exist in ${environment}`, () => {
      assert.equal(JSON.stringify(synth(environment).toJSON()).includes(INTEGRATION_TEST_ROLE_NAME), false);
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
