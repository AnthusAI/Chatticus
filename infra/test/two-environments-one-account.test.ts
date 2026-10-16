import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as cdk from "aws-cdk-lib";
import { AccountGitHubDeployStack } from "../lib/account-github-deploy-stack";
import { buildDedicatedAccountStacks } from "../lib/dedicated-account-stacks";
import {
  ACCOUNT_DEPLOY_CREATES_OIDC_PROVIDER,
  ACCOUNT_DEPLOY_ROLE_NAMES,
  ACCOUNT_DEPLOY_STACK_IDS,
  COMPUTER_IMAGE_TAGS,
  COMPUTERS_STACK_IDS,
  SNAPSHOT_STACK_IDS,
  peerEnvironmentsInSameAccount,
  stackIdsOfEnvironment,
  type ChatticusCloudEnvironment,
} from "../lib/environments";
import { applyStandardTags, stackTagsFor } from "../lib/tagging";
import { stubWebsiteDeploySource } from "../lib/web-bundle-stub";
import { normalizedTemplateText } from "./template-normalization";

const PRODUCTION_ACCOUNT_ENV = { account: "555555555555", region: "us-east-1" };
const BUDGETS_CONFIG = { monthlyLimitUsd: 125, notificationEmails: ["owner@example.com"] };
const SHARED_ACCOUNT_ENVIRONMENTS = ["staging", "production"] as const;

interface TemplateResource {
  Type: string;
  Properties?: Record<string, unknown>;
}

type SynthesizedTemplates = Record<string, { Resources?: Record<string, TemplateResource> }>;

function synthesizeEnvironmentInSharedAccount(environment: "staging" | "production"): SynthesizedTemplates {
  const app = new cdk.App();
  buildDedicatedAccountStacks(app, {
    env: PRODUCTION_ACCOUNT_ENV,
    environmentName: environment,
    budgetsConfig: BUDGETS_CONFIG,
    websiteDeploySource: stubWebsiteDeploySource,
  });
  new AccountGitHubDeployStack(app, ACCOUNT_DEPLOY_STACK_IDS[environment], {
    env: PRODUCTION_ACCOUNT_ENV,
    githubEnvironment: environment,
  });
  for (const stack of app.node.children.filter(cdk.Stack.isStack)) {
    applyStandardTags(stack, "Test Installation", environment);
  }
  const assembly = app.synth();
  return Object.fromEntries(
    assembly.stacks.map((stack) => [stack.stackName, stack.template as SynthesizedTemplates[string]]),
  );
}

const synthesized: Record<"staging" | "production", SynthesizedTemplates> = {
  staging: synthesizeEnvironmentInSharedAccount("staging"),
  production: synthesizeEnvironmentInSharedAccount("production"),
};

const ACCOUNT_LEVEL_STACK_NAMES = ["ChatticusBudgets"];
const LIVE_PRODUCTION_STACK_NAMES = [
  "ChatticusAccountDeploy",
  "ChatticusAuthProduction",
  "ChatticusBudgets",
  "ChatticusComputers",
  "ChatticusControlPlaneProduction",
  "ChatticusEnvironmentCertificates",
  "ChatticusEnvironmentZones",
  "ChatticusSnapshots",
  "ChatticusThinTurnProduction",
  "ChatticusWebProduction",
];
const NEW_STAGING_STACK_NAMES = [
  "ChatticusAccountDeployStaging",
  "ChatticusAuthStaging",
  "ChatticusBudgets",
  "ChatticusComputersStaging",
  "ChatticusControlPlaneStaging",
  "ChatticusEnvironmentCertificatesStaging",
  "ChatticusEnvironmentZonesStaging",
  "ChatticusSnapshotsStaging",
  "ChatticusThinTurnStaging",
  "ChatticusWebStaging",
];

function stackNamesOf(environment: "staging" | "production"): string[] {
  return Object.keys(synthesized[environment]).sort();
}

function resourcesOf(templates: SynthesizedTemplates, types: readonly string[]): Array<{ stack: string; id: string; resource: TemplateResource }> {
  return Object.entries(templates).flatMap(([stack, template]) =>
    Object.entries(template.Resources ?? {})
      .filter(([, resource]) => types.includes(resource.Type))
      .map(([id, resource]) => ({ stack, id, resource })),
  );
}

describe("staging and production in one AWS account", () => {
  it("builds every per-environment stack under that environment's own id", () => {
    for (const environment of SHARED_ACCOUNT_ENVIRONMENTS) {
      const expected = [...stackIdsOfEnvironment(environment), ...ACCOUNT_LEVEL_STACK_NAMES].sort();
      const actual = stackNamesOf(environment);
      for (const id of actual) {
        assert.ok(expected.includes(id), `${environment} built unexpected stack ${id}`);
      }
      for (const id of [
        SNAPSHOT_STACK_IDS[environment],
        COMPUTERS_STACK_IDS[environment],
        ACCOUNT_DEPLOY_STACK_IDS[environment],
      ]) {
        assert.ok(actual.includes(id), `${environment} is missing ${id}`);
      }
    }
  });

  it("gives staging and production disjoint stack names, sharing only the account-level budget stack", () => {
    const staging = stackNamesOf("staging");
    const production = stackNamesOf("production");
    const shared = staging.filter((name) => production.includes(name)).sort();
    assert.deepEqual(shared, [...ACCOUNT_LEVEL_STACK_NAMES].sort());
  });

  it("builds for production exactly the stacks the production account already holds, under their live names", () => {
    assert.deepEqual(stackNamesOf("production"), LIVE_PRODUCTION_STACK_NAMES);
  });

  it("builds for staging the suffixed copies, which do not exist yet", () => {
    assert.deepEqual(stackNamesOf("staging"), NEW_STAGING_STACK_NAMES);
  });

  it("deploys the budget stack from production only: the account's one budget keeps its production tag", () => {
    assert.equal(stackTagsFor("ChatticusBudgets", "production").environment, "production");
    assert.deepEqual(
      resourcesOf({ budgets: synthesized.production.ChatticusBudgets }, ["AWS::SNS::Topic"]).map((entry) => entry.resource.Type),
      ["AWS::SNS::Topic"],
    );
  });

  it("keeps resources with fixed names apart: no two environments claim the same account-wide name", () => {
    const fixedNamesOf = (templates: SynthesizedTemplates): Map<string, string> => {
      const names = new Map<string, string>();
      for (const { stack, id, resource } of resourcesOf(templates, [
        "AWS::IAM::Role",
        "AWS::IAM::ManagedPolicy",
        "AWS::Lambda::Function",
        "AWS::Cognito::UserPool",
        "AWS::Cognito::UserPoolDomain",
        "AWS::ECS::TaskDefinition",
        "AWS::CloudWatch::Alarm",
        "AWS::Scheduler::ScheduleGroup",
        "AWS::SSM::Parameter",
        "AWS::Route53::HostedZone",
        "AWS::SecretsManager::Secret",
        "AWS::S3::Bucket",
        "AWS::DynamoDB::Table",
        "AWS::SQS::Queue",
        "AWS::SNS::Topic",
        "AWS::ECR::Repository",
        "AWS::Logs::LogGroup",
      ])) {
        if (ACCOUNT_LEVEL_STACK_NAMES.includes(stack)) continue;
        for (const key of ["RoleName", "ManagedPolicyName", "FunctionName", "UserPoolName", "Domain", "Family", "AlarmName", "Name", "TopicName", "TableName", "QueueName", "BucketName", "RepositoryName", "LogGroupName"]) {
          const value = resource.Properties?.[key];
          if (typeof value === "string") names.set(`${resource.Type}/${key}/${value}`, `${stack}/${id}`);
        }
      }
      return names;
    };
    const staging = fixedNamesOf(synthesized.staging);
    const production = fixedNamesOf(synthesized.production);
    assert.ok(staging.size > 0, "the scan found fixed names to compare");
    const collisions = [...staging.keys()].filter((name) => production.has(name));
    assert.deepEqual(collisions, []);
  });

  it("runs each environment's owner task on its own image tag in its own repository and task definition family", () => {
    const taskDefinitionOf = (environment: "staging" | "production") => {
      const [{ resource }] = resourcesOf(synthesized[environment], ["AWS::ECS::TaskDefinition"]);
      return resource.Properties as { Family: string; ContainerDefinitions: Array<{ Image: unknown }> };
    };
    const staging = taskDefinitionOf("staging");
    const production = taskDefinitionOf("production");
    assert.equal(production.Family, "ChatticusComputerOwner");
    assert.equal(staging.Family, "ChatticusComputerOwnerStaging");
    assert.match(JSON.stringify(staging.ContainerDefinitions[0].Image), new RegExp(`:${COMPUTER_IMAGE_TAGS.staging}"`));
    assert.match(JSON.stringify(production.ContainerDefinitions[0].Image), new RegExp(`:${COMPUTER_IMAGE_TAGS.production}"`));
    assert.doesNotMatch(JSON.stringify(staging.ContainerDefinitions[0].Image), /:dev"/);
    assert.doesNotMatch(JSON.stringify(production.ContainerDefinitions[0].Image), /:dev"/);
    for (const environment of SHARED_ACCOUNT_ENVIRONMENTS) {
      const repositories = resourcesOf(synthesized[environment], ["AWS::ECR::Repository"]);
      assert.equal(repositories.length, 1);
      assert.equal(repositories[0].stack, COMPUTERS_STACK_IDS[environment]);
    }
  });

  it("gives the three environments three distinct image tags, with development keeping dev", () => {
    assert.deepEqual(COMPUTER_IMAGE_TAGS, { development: "dev", staging: "staging", production: "production" });
  });

  it("creates the GitHub OIDC provider in production's deploy stack only, and imports it in staging's", () => {
    assert.deepEqual(ACCOUNT_DEPLOY_CREATES_OIDC_PROVIDER, { development: true, staging: false, production: true });
    const providers = SHARED_ACCOUNT_ENVIRONMENTS.flatMap((environment) =>
      resourcesOf(synthesized[environment], ["AWS::IAM::OIDCProvider"]).map((entry) => `${environment}:${entry.stack}`),
    );
    assert.deepEqual(providers, ["production:ChatticusAccountDeploy"]);
    const [{ resource }] = resourcesOf(synthesized.production, ["AWS::IAM::OIDCProvider"]);
    assert.equal(resource.Properties?.Url, "https://token.actions.githubusercontent.com");
    assert.deepEqual(resource.Properties?.ClientIdList, ["sts.amazonaws.com"]);
  });

  it("gives each environment its own deploy role name", () => {
    for (const environment of SHARED_ACCOUNT_ENVIRONMENTS) {
      const roleNames = resourcesOf({ [ACCOUNT_DEPLOY_STACK_IDS[environment]]: synthesized[environment][ACCOUNT_DEPLOY_STACK_IDS[environment]] }, ["AWS::IAM::Role"]).map(
        (entry) => entry.resource.Properties?.RoleName,
      );
      assert.deepEqual(roleNames, [ACCOUNT_DEPLOY_ROLE_NAMES[environment]]);
    }
    assert.notEqual(ACCOUNT_DEPLOY_ROLE_NAMES.staging, ACCOUNT_DEPLOY_ROLE_NAMES.production);
  });
});

describe("IAM is scoped per environment in the shared account", () => {
  const IAM_TYPES = ["AWS::IAM::Role", "AWS::IAM::Policy", "AWS::IAM::ManagedPolicy"] as const;

  function iamTextOf(environment: "staging" | "production"): Array<{ stack: string; id: string; text: string }> {
    const stacks: SynthesizedTemplates = Object.fromEntries(
      Object.entries(synthesized[environment]).filter(
        ([name]) => !ACCOUNT_LEVEL_STACK_NAMES.includes(name) && name !== ACCOUNT_DEPLOY_STACK_IDS[environment],
      ),
    );
    return resourcesOf(stacks, IAM_TYPES).map(({ stack, id, resource }) => ({ stack, id, text: JSON.stringify(resource) }));
  }

  function namesStack(text: string, stackId: string): boolean {
    return new RegExp(`${stackId}(?![A-Za-z])`).test(text);
  }

  it("lets no staging role or policy name a production resource, and no production role or policy name a staging one", () => {
    const stagingIam = iamTextOf("staging");
    const productionIam = iamTextOf("production");
    assert.ok(stagingIam.length > 0 && productionIam.length > 0, "the scan found roles and policies");
    for (const entry of stagingIam) {
      assert.doesNotMatch(entry.text, /production/i, `${entry.stack}/${entry.id}`);
      for (const productionStackId of stackIdsOfEnvironment("production")) {
        assert.equal(namesStack(entry.text, productionStackId), false, `${entry.stack}/${entry.id} names ${productionStackId}`);
      }
    }
    for (const entry of productionIam) {
      assert.doesNotMatch(entry.text, /staging/i, `${entry.stack}/${entry.id}`);
      for (const stagingStackId of stackIdsOfEnvironment("staging")) {
        assert.equal(namesStack(entry.text, stagingStackId), false, `${entry.stack}/${entry.id} names ${stagingStackId}`);
      }
    }
  });

  it("lets each deploy role allow nothing that names the other environment, and deny the other environment explicitly", () => {
    for (const environment of SHARED_ACCOUNT_ENVIRONMENTS) {
      const peer = peerEnvironmentsInSameAccount(environment)[0] as ChatticusCloudEnvironment;
      const policies = resourcesOf(
        { deploy: synthesized[environment][ACCOUNT_DEPLOY_STACK_IDS[environment]] },
        ["AWS::IAM::Policy"],
      );
      const statements = policies.flatMap(
        (entry) => (entry.resource.Properties as { PolicyDocument: { Statement: Array<{ Sid?: string; Effect: string }> } }).PolicyDocument.Statement,
      );
      const allowed = statements.filter((statement) => statement.Effect === "Allow");
      const denied = statements.filter((statement) => statement.Effect === "Deny");
      assert.deepEqual(allowed.map((statement) => statement.Sid).sort(), [
        "AssumeCdkBootstrapRoles",
        "ComputerImagePush",
        "EcrLoginToken",
        "ReadEnvironmentParameters",
        "ReadEnvironmentStacks",
        "ReadInvokeKeySecretVersions",
      ]);
      const allowedText = JSON.stringify(allowed);
      for (const peerStackId of stackIdsOfEnvironment(peer)) {
        assert.equal(allowedText.includes(`:stack/${peerStackId}/`), false, `${environment} role allows ${peerStackId}`);
      }
      assert.equal(allowedText.includes(`/chatticus/${peer}/`), false);
      assert.deepEqual(denied.map((statement) => statement.Sid).sort(), [
        "DenyIdentityAndAccountAdministration",
        "DenyPeerEnvironmentParameters",
        "DenyPeerEnvironmentStacks",
        "DenyPeerEnvironmentTaggedResources",
      ]);
      const deniedText = JSON.stringify(denied);
      for (const peerStackId of stackIdsOfEnvironment(peer)) {
        assert.ok(deniedText.includes(`${peerStackId}/*`), `${environment} role denies ${peerStackId}`);
      }
      for (const ownStackId of stackIdsOfEnvironment(environment)) {
        assert.equal(deniedText.includes(`:stack/${ownStackId}/`), false, `${environment} role must not deny its own ${ownStackId}`);
      }
      assert.ok(deniedText.includes(`/chatticus/${peer}/`));
      assert.equal(deniedText.includes(`/chatticus/${environment}/`), false);
      assert.ok(deniedText.includes(`"aws:ResourceTag/chatticus:environment":["${peer}"]`));
    }
  });

  it("tags every stack of an environment with that environment, the account's budget stack with production", () => {
    for (const environment of SHARED_ACCOUNT_ENVIRONMENTS) {
      for (const id of stackIdsOfEnvironment(environment)) {
        assert.equal(stackTagsFor(id, environment).environment, environment, id);
      }
    }
    assert.equal(stackTagsFor("ChatticusBudgets", "production").environment, "production");
  });
});

describe("development is unchanged by the shared-account design", () => {
  const FIXTURE_DIRECTORY = join(__dirname, "fixtures", "development-templates");
  const DEVELOPMENT_ENV = { region: "us-east-1" };

  const normalized = normalizedTemplateText;

  const cdkJsonContext = JSON.parse(readFileSync(join(__dirname, "..", "cdk.json"), "utf8")).context as Record<string, unknown>;

  function fixture(stackId: string): string {
    return readFileSync(join(FIXTURE_DIRECTORY, `${stackId}.template.json`), "utf8");
  }

  const developmentApp = new cdk.App({ context: cdkJsonContext });
  buildDedicatedAccountStacks(developmentApp, {
    env: DEVELOPMENT_ENV,
    environmentName: "development",
    websiteDeploySource: stubWebsiteDeploySource,
  });
  for (const stack of developmentApp.node.children.filter(cdk.Stack.isStack)) {
    applyStandardTags(stack, "Test", "development");
  }
  const developmentAssembly = developmentApp.synth();

  const deployApp = new cdk.App({ context: cdkJsonContext });
  new AccountGitHubDeployStack(deployApp, ACCOUNT_DEPLOY_STACK_IDS.development, {
    env: DEVELOPMENT_ENV,
    githubEnvironment: "development",
    description: "GitHub Actions OIDC provider and development deploy role for this environment account.",
  });
  applyStandardTags(deployApp.node.findChild(ACCOUNT_DEPLOY_STACK_IDS.development) as cdk.Stack, "Test");
  const deployAssembly = deployApp.synth();

  for (const stackId of [
    "ChatticusSnapshots",
    "ChatticusComputers",
    "ChatticusEnvironmentZones",
    "ChatticusEnvironmentCertificates",
  ]) {
    it(`synthesizes ${stackId} exactly as it was before staging and production shared an account`, () => {
      assert.equal(normalized(developmentAssembly.getStackByName(stackId).template), fixture(stackId));
    });
  }

  it("synthesizes ChatticusAccountDeploy exactly as it was, with its own OIDC provider and the unsuffixed role name", () => {
    assert.equal(normalized(deployAssembly.getStackByName("ChatticusAccountDeploy").template), fixture("ChatticusAccountDeploy"));
  });

  it("keeps the unsuffixed development stack ids", () => {
    assert.deepEqual(
      [SNAPSHOT_STACK_IDS.development, COMPUTERS_STACK_IDS.development, ACCOUNT_DEPLOY_STACK_IDS.development],
      ["ChatticusSnapshots", "ChatticusComputers", "ChatticusAccountDeploy"],
    );
    assert.deepEqual(peerEnvironmentsInSameAccount("development"), []);
  });
});

describe("production keeps the stacks, logical ids and resource names it was deployed with", () => {
  const FIXTURE_DIRECTORY = join(__dirname, "fixtures", "production-templates");
  const PRODUCTION_ENV = { region: "us-east-1" };
  const cdkJsonContext = JSON.parse(readFileSync(join(__dirname, "..", "cdk.json"), "utf8")).context as Record<string, unknown>;

  const productionApp = new cdk.App({ context: cdkJsonContext });
  buildDedicatedAccountStacks(productionApp, {
    env: PRODUCTION_ENV,
    environmentName: "production",
    websiteDeploySource: stubWebsiteDeploySource,
  });
  new AccountGitHubDeployStack(productionApp, ACCOUNT_DEPLOY_STACK_IDS.production, {
    env: PRODUCTION_ENV,
    githubEnvironment: "production",
    description: "GitHub Actions OIDC provider and production deploy role for this environment account.",
  });
  for (const stack of productionApp.node.children.filter(cdk.Stack.isStack)) {
    applyStandardTags(stack, "Test", stack.node.id === ACCOUNT_DEPLOY_STACK_IDS.production ? undefined : "production");
  }
  const productionAssembly = productionApp.synth();

  for (const stackId of [
    "ChatticusSnapshots",
    "ChatticusComputers",
    "ChatticusEnvironmentZones",
    "ChatticusEnvironmentCertificates",
    "ChatticusAccountDeploy",
  ]) {
    it(`synthesizes ${stackId} to the committed production template`, () => {
      assert.equal(
        normalizedTemplateText(productionAssembly.getStackByName(stackId).template),
        readFileSync(join(FIXTURE_DIRECTORY, `${stackId}.template.json`), "utf8"),
      );
    });
  }

  it("keeps the production zones' and certificates' hostnames, the delegation the live name servers depend on", () => {
    const zones = productionAssembly.getStackByName("ChatticusEnvironmentZones").template as SynthesizedTemplates[string];
    const names = resourcesOf({ zones }, ["AWS::Route53::HostedZone"]).map((entry) => entry.resource.Properties?.Name).sort();
    assert.deepEqual(names, ["auth.chattic.us.", "hey.chattic.us."]);
  });

  it("owns the GitHub OIDC provider and the unsuffixed deploy role it already has", () => {
    const template = productionAssembly.getStackByName("ChatticusAccountDeploy").template as SynthesizedTemplates[string];
    assert.equal(resourcesOf({ template }, ["AWS::IAM::OIDCProvider"]).length, 1);
    assert.deepEqual(
      resourcesOf({ template }, ["AWS::IAM::Role"]).map((entry) => entry.resource.Properties?.RoleName),
      ["chatticus-github-actions-deploy"],
    );
  });
});
