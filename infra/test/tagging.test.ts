import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as cdk from "aws-cdk-lib";
import {
  AUTH_STACK_IDS,
  CHATTICUS_CLOUD_ENVIRONMENTS,
  THIN_TURN_STACK_IDS,
  WEB_STACK_IDS,
} from "../lib/environments";
import {
  APPLICATION_NAME,
  SHARED_ENVIRONMENT,
  applyStandardTags,
  readInstallationName,
  stackTagsFor,
} from "../lib/tagging";

describe("stack tag registry", () => {
  it("classifies every per-environment stack with its environment", () => {
    for (const environment of CHATTICUS_CLOUD_ENVIRONMENTS) {
      assert.deepEqual(stackTagsFor(THIN_TURN_STACK_IDS[environment]), { component: "thin-turn", environment });
      assert.deepEqual(stackTagsFor(WEB_STACK_IDS[environment]), { component: "web", environment });
      assert.deepEqual(stackTagsFor(AUTH_STACK_IDS[environment]), { component: "auth", environment });
    }
  });

  it("classifies the shared stacks as shared", () => {
    const expected: Record<string, string> = {
      ChatticusBudgets: "budgets",
      ChatticusSnapshots: "snapshots",
      ChatticusComputers: "computer",
      ChatticusDns: "dns",
      ChatticusGitHubDeploy: "deploy",
      ChatticusIntegrationTest: "integration-test",
    };
    for (const [id, component] of Object.entries(expected)) {
      assert.deepEqual(stackTagsFor(id), { component, environment: SHARED_ENVIRONMENT });
    }
  });

  it("refuses a stack nobody classified, so a new stack cannot ship untagged", () => {
    assert.throws(() => stackTagsFor("ChatticusSomethingNew"), /no entry in lib\/tagging\.ts/);
  });
});

describe("installation name", () => {
  it("is absent when unset or blank", () => {
    assert.equal(readInstallationName({}), undefined);
    assert.equal(readInstallationName({ CHATTICUS_INSTALLATION_NAME: "   " }), undefined);
  });

  it("keeps a readable name with spaces", () => {
    assert.equal(readInstallationName({ CHATTICUS_INSTALLATION_NAME: " Anthus AI Solutions " }), "Anthus AI Solutions");
  });

  it("rejects a value AWS cannot use as a tag", () => {
    assert.throws(() => readInstallationName({ CHATTICUS_INSTALLATION_NAME: "Anthus <AI>" }), /not a valid AWS tag value/);
  });
});

describe("applyStandardTags", () => {
  const tagsOf = (id: string, installation: string | undefined) => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, id);
    new cdk.aws_sqs.Queue(stack, "Q");
    applyStandardTags(stack, installation);
    const template = app.synth().getStackByName(id).template;
    const queue = Object.values(template.Resources as Record<string, { Type: string; Properties: { Tags?: Array<{ Key: string; Value: string }> } }>).find(
      (r) => r.Type === "AWS::SQS::Queue",
    );
    return Object.fromEntries((queue?.Properties.Tags ?? []).map((t) => [t.Key, t.Value]));
  };

  it("tags a resource with application, component, environment and installation", () => {
    assert.deepEqual(tagsOf(THIN_TURN_STACK_IDS.staging, "Anthus AI Solutions"), {
      "chatticus:application": APPLICATION_NAME,
      "chatticus:component": "thin-turn",
      "chatticus:environment": "staging",
      "chatticus:installation": "Anthus AI Solutions",
    });
  });

  it("omits the installation tag when no name is configured", () => {
    const tags = tagsOf("ChatticusDns", undefined);
    assert.equal("chatticus:installation" in tags, false);
    assert.equal(tags["chatticus:environment"], "shared");
  });
});
