import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AccountGitHubDeployStack } from "../lib/account-github-deploy-stack";
import { COMPUTER_IMAGE_PUSH_ACTIONS } from "../lib/deploy-role-policy";
import { CHATTICUS_CLOUD_ENVIRONMENTS, type ChatticusCloudEnvironment } from "../lib/environments";
import { GitHubDeployStack } from "../lib/github-deploy-stack";

const ENV = { account: "222222222222", region: "us-east-1" };
const REPOSITORY_ROOT = join(__dirname, "..", "..");

interface Statement {
  Sid?: string;
  Effect: "Allow" | "Deny";
  Action: string | string[];
  Resource?: unknown;
  Condition?: unknown;
}

interface RoleView {
  roleName: string;
  managedPolicyArns: string;
  statements: Statement[];
}

function actionsOf(statement: Statement): string[] {
  return Array.isArray(statement.Action) ? statement.Action : [statement.Action];
}

function resourcesOf(statement: Statement): string[] {
  return ([] as unknown[]).concat(statement.Resource).map((resource) => JSON.stringify(resource));
}

function wildcardMatches(pattern: string, value: string): boolean {
  const expression = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${expression}$`, "i").test(value);
}

function roleViews(template: Template): RoleView[] {
  const roles = template.findResources("AWS::IAM::Role");
  const policies = Object.values(template.findResources("AWS::IAM::Policy"));
  return Object.entries(roles).map(([logicalId, resource]) => {
    const properties = resource.Properties as { RoleName: string; ManagedPolicyArns?: unknown };
    const statements = policies
      .filter((policy) =>
        ((policy.Properties as { Roles: Array<{ Ref: string }> }).Roles ?? []).some((role) => role.Ref === logicalId),
      )
      .flatMap(
        (policy) => (policy.Properties as { PolicyDocument: { Statement: Statement[] } }).PolicyDocument.Statement,
      );
    return {
      roleName: properties.RoleName,
      managedPolicyArns: JSON.stringify(properties.ManagedPolicyArns ?? []),
      statements,
    };
  });
}

function synthAccount(environment: ChatticusCloudEnvironment): RoleView {
  const app = new cdk.App();
  const stack = new AccountGitHubDeployStack(app, "ChatticusAccountDeploy", { env: ENV, githubEnvironment: environment });
  const views = roleViews(Template.fromStack(stack));
  assert.equal(views.length, 1);
  return views[0];
}

function synthLegacy(): RoleView[] {
  const app = new cdk.App();
  const stack = new GitHubDeployStack(app, "ChatticusGitHubDeploy", { env: ENV });
  return roleViews(Template.fromStack(stack));
}

function environmentOfRoleName(roleName: string): ChatticusCloudEnvironment {
  if (roleName.endsWith("-staging")) return "staging";
  if (roleName.endsWith("-production")) return "production";
  return "development";
}

const SUBJECTS: Array<{ label: string; environment: ChatticusCloudEnvironment; view: RoleView }> = [
  ...CHATTICUS_CLOUD_ENVIRONMENTS.map((environment) => ({
    label: `account deploy role (${environment})`,
    environment,
    view: synthAccount(environment),
  })),
  ...synthLegacy().map((view) => ({
    label: `legacy deploy role ${view.roleName}`,
    environment: environmentOfRoleName(view.roleName),
    view,
  })),
];

const EXPECTED_ALLOWED_ACTIONS = [
  "cloudformation:DescribeStackEvents",
  "cloudformation:DescribeStackResources",
  "cloudformation:DescribeStacks",
  "cloudformation:GetTemplate",
  "cloudformation:ListStackResources",
  ...COMPUTER_IMAGE_PUSH_ACTIONS,
  "ecr:GetAuthorizationToken",
  "secretsmanager:ListSecretVersionIds",
  "ssm:GetParameter",
  "sts:AssumeRole",
  "sts:TagSession",
].sort();

const AWS_CLI_CALL_TO_IAM_ACTIONS: Record<string, string[]> = {
  "sts get-caller-identity": [],
  "cloudformation describe-stacks": ["cloudformation:DescribeStacks"],
  "ssm get-parameter": ["ssm:GetParameter"],
  "secretsmanager list-secret-version-ids": ["secretsmanager:ListSecretVersionIds"],
  "ecr get-login-password": ["ecr:GetAuthorizationToken"],
  "ecr describe-images": ["ecr:DescribeImages"],
  "ecr batch-get-image": ["ecr:BatchGetImage"],
  "ecr put-image": ["ecr:PutImage"],
};

const CDK_BOOTSTRAP_ROLE_KINDS = ["deploy-role", "file-publishing-role", "image-publishing-role", "lookup-role"];

function allowStatements(view: RoleView): Statement[] {
  return view.statements.filter((statement) => statement.Effect === "Allow");
}

function denyStatements(view: RoleView): Statement[] {
  return view.statements.filter((statement) => statement.Effect === "Deny");
}

function isAllowedByPolicy(view: RoleView, action: string): boolean {
  const unconditionalDeny = denyStatements(view).some(
    (statement) =>
      statement.Condition === undefined &&
      JSON.stringify(statement.Resource) === '"*"' &&
      actionsOf(statement).some((pattern) => wildcardMatches(pattern, action)),
  );
  const allowed = allowStatements(view).some((statement) =>
    actionsOf(statement).some((pattern) => wildcardMatches(pattern, action)),
  );
  return allowed && !unconditionalDeny;
}

for (const { label, environment, view } of SUBJECTS) {
  describe(`least privilege: ${label}`, () => {
    it("is no longer AdministratorAccess and carries no managed policy at all", () => {
      assert.doesNotMatch(view.managedPolicyArns, /AdministratorAccess/);
      assert.equal(view.managedPolicyArns, "[]");
    });

    it("allows exactly the enumerated workflow actions and nothing else", () => {
      const actions = [...new Set(allowStatements(view).flatMap(actionsOf))].sort();
      assert.deepEqual(actions, EXPECTED_ALLOWED_ACTIONS);
    });

    it("never allows a wildcard action, an IAM, Organizations or Account action, or any action on every resource", () => {
      for (const statement of allowStatements(view)) {
        for (const action of actionsOf(statement)) {
          assert.doesNotMatch(action, /\*/, `${statement.Sid}: ${action}`);
          assert.doesNotMatch(action, /^(iam|organizations|account):/i, `${statement.Sid}: ${action}`);
        }
      }
      const everyResource = allowStatements(view).filter((statement) => JSON.stringify(statement.Resource) === '"*"');
      assert.deepEqual(
        everyResource.map((statement) => actionsOf(statement)),
        [["ecr:GetAuthorizationToken"]],
      );
    });

    it("assumes only the four CDK bootstrap roles of its own account and region", () => {
      const statement = allowStatements(view).find((candidate) => actionsOf(candidate).includes("sts:AssumeRole"));
      assert.ok(statement);
      assert.deepEqual(actionsOf(statement).sort(), ["sts:AssumeRole", "sts:TagSession"]);
      const resources = resourcesOf(statement);
      assert.equal(resources.length, CDK_BOOTSTRAP_ROLE_KINDS.length);
      for (const kind of CDK_BOOTSTRAP_ROLE_KINDS) {
        assert.ok(
          resources.some((resource) => resource.includes(`:role/cdk-hnb659fds-${kind}-222222222222-us-east-1`)),
          kind,
        );
      }
      assert.ok(resources.every((resource) => !resource.includes("cfn-exec")));
    });

    it("pushes the computer image to this environment's repository only", () => {
      const push = allowStatements(view).find((statement) => statement.Sid === "ComputerImagePush");
      assert.ok(push);
      assert.deepEqual(actionsOf(push).sort(), [...COMPUTER_IMAGE_PUSH_ACTIONS].sort());
      const expectedPrefix = environment === "staging" ? "chatticuscomputersstaging" : "chatticuscomputers";
      assert.match(JSON.stringify(push.Resource), new RegExp(`:repository/${expectedPrefix}-computerimage\\*`));
    });

    it("reads parameters only under its own environment prefix and the CDK bootstrap version", () => {
      const parameters = allowStatements(view).filter((statement) => actionsOf(statement).includes("ssm:GetParameter"));
      const resources = parameters.flatMap(resourcesOf);
      assert.ok(resources.some((resource) => resource.includes(`:parameter/chatticus/${environment}/*`)));
      assert.ok(resources.some((resource) => resource.includes(":parameter/cdk-bootstrap/hnb659fds/version")));
      for (const other of CHATTICUS_CLOUD_ENVIRONMENTS.filter((name) => name !== environment)) {
        assert.ok(resources.every((resource) => !resource.includes(`/chatticus/${other}/`)));
      }
    });

    it("reads invoke key secret versions only on secrets tagged with its environment", () => {
      const secrets = allowStatements(view).find((statement) =>
        actionsOf(statement).includes("secretsmanager:ListSecretVersionIds"),
      );
      assert.ok(secrets);
      assert.deepEqual(secrets.Condition, {
        StringEquals: { "aws:ResourceTag/chatticus:environment": environment },
      });
    });

    it("explicitly denies IAM users, access keys, login profiles, Organizations and Account actions", () => {
      const denied = denyStatements(view).flatMap(actionsOf);
      for (const action of [
        "iam:CreateUser",
        "iam:CreateLoginProfile",
        "iam:UpdateLoginProfile",
        "organizations:*",
        "account:*",
      ]) {
        assert.ok(denied.includes(action), action);
      }
      assert.ok(denied.some((pattern) => wildcardMatches(pattern, "iam:Create" + "AccessKey")));
      assert.ok(denied.some((pattern) => wildcardMatches(pattern, "iam:Update" + "AccessKey")));
      const everyResource = denyStatements(view).find((statement) => actionsOf(statement).includes("organizations:*"));
      assert.equal(JSON.stringify(everyResource?.Resource), '"*"');
    });

    it("permits every AWS call the deploy, build, promote and verify workflows make", () => {
      for (const [call, actions] of Object.entries(AWS_CLI_CALL_TO_IAM_ACTIONS)) {
        for (const action of actions) {
          assert.ok(isAllowedByPolicy(view, action), `${call} needs ${action}`);
        }
      }
      for (const action of ["ecr:PutImage", "ecr:DescribeImages", "ecr:BatchGetImage", "ecr:GetAuthorizationToken"]) {
        assert.ok(isAllowedByPolicy(view, action), action);
      }
    });

    it("cannot mint a user or access key, leave the organization or touch other services", () => {
      for (const action of [
        "iam:Create" + "User",
        "iam:Create" + "AccessKey",
        "iam:AttachRolePolicy",
        "organizations:LeaveOrganization",
        "account:CloseAccount",
        "s3:DeleteBucket",
        "dynamodb:DeleteTable",
        "ec2:RunInstances",
      ]) {
        assert.equal(isAllowedByPolicy(view, action), false, action);
      }
    });
  });
}

describe("least privilege: peer environment denies remain where staging and production share an account", () => {
  for (const [environment, peer] of [
    ["staging", "production"],
    ["production", "staging"],
  ] as const) {
    it(`${environment} still denies ${peer}'s stacks, parameters and tagged resources`, () => {
      const denies = denyStatements(synthAccount(environment));
      const sids = denies.map((statement) => statement.Sid);
      for (const sid of ["DenyPeerEnvironmentStacks", "DenyPeerEnvironmentParameters", "DenyPeerEnvironmentTaggedResources"]) {
        assert.ok(sids.includes(sid), sid);
      }
      const tagged = denies.find((statement) => statement.Sid === "DenyPeerEnvironmentTaggedResources");
      assert.deepEqual(tagged?.Condition, { StringEquals: { "aws:ResourceTag/chatticus:environment": [peer] } });
    });
  }

  it("development has no peer in its account, so no peer denies", () => {
    const sids = denyStatements(synthAccount("development")).map((statement) => statement.Sid);
    assert.ok(!sids.includes("DenyPeerEnvironmentStacks"));
  });
});

describe("least privilege: the workflows and scripts cannot call an AWS API the role lacks", () => {
  const scannedFiles = [
    ...readdirSync(join(REPOSITORY_ROOT, ".github", "workflows"))
      .filter((name) => name.endsWith(".yml"))
      .map((name) => join(REPOSITORY_ROOT, ".github", "workflows", name)),
    join(REPOSITORY_ROOT, "infra", "deploy-chatticus-dedicated-account.sh"),
    join(REPOSITORY_ROOT, "infra", "promote-computer-image.sh"),
  ];

  it("lists every aws CLI call so a new call forces a policy decision", () => {
    const unknown: string[] = [];
    for (const file of scannedFiles) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("#") || trimmed.startsWith("echo") || trimmed.startsWith("aws-region")) continue;
        for (const match of trimmed.matchAll(/(?:^|[\s$("'|])aws ([a-z0-9]+) ([a-z0-9-]+)/g)) {
          const call = `${match[1]} ${match[2]}`;
          if (!(call in AWS_CLI_CALL_TO_IAM_ACTIONS) && !/^(login|sso) /.test(call)) {
            unknown.push(`${file.replace(REPOSITORY_ROOT, "")}: ${call}`);
          }
        }
      }
    }
    assert.deepEqual([...new Set(unknown)], []);
  });

  it("deploys through the CDK bootstrap roles and never calls IAM or static keys", () => {
    for (const file of scannedFiles) {
      const contents = readFileSync(file, "utf8");
      assert.doesNotMatch(contents, /\baws iam\b/, file);
      assert.doesNotMatch(contents, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/, file);
    }
  });
});
