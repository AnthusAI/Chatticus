import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import {
  ENVIRONMENT_CERTIFICATES_STACK_ID,
  ENVIRONMENT_ZONES_STACK_ID,
  buildDedicatedAccountStacks,
  readDedicatedEnvironment,
} from "../lib/dedicated-account-stacks";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHATTICUS_CLOUD_ENVIRONMENTS,
  CONTROL_PLANE_STACK_IDS,
  DEDICATED_ACCOUNT_HOSTNAMES,
  THIN_TURN_STACK_IDS,
  WEB_STACK_IDS,
} from "../lib/environments";
import { applyStandardTags, stackTagsFor } from "../lib/tagging";
import { stubWebsiteDeploySource } from "../lib/web-bundle-stub";

const ENV = { account: "444444444444", region: "us-east-1" };

function buildDevelopment(): cdk.App {
  const app = new cdk.App();
  buildDedicatedAccountStacks(app, {
    env: ENV,
    environmentName: "development",
    websiteDeploySource: stubWebsiteDeploySource,
  });
  return app;
}

function template(app: cdk.App, stackId: string): Template {
  return Template.fromStack(app.node.findChild(stackId) as cdk.Stack);
}

describe("dedicated account mode", () => {
  const app = buildDevelopment();
  const stackIds = app.node.children.filter(cdk.Stack.isStack).map((stack) => stack.node.id).sort();

  it("builds one environment's stacks and its own shared stacks, never the legacy account's", () => {
    assert.deepEqual(stackIds, [
      "ChatticusAuth",
      "ChatticusComputers",
      "ChatticusControlPlane",
      ENVIRONMENT_CERTIFICATES_STACK_ID,
      ENVIRONMENT_ZONES_STACK_ID,
      "ChatticusSnapshots",
      "ChatticusThinTurn",
      "ChatticusWeb",
    ].sort());
    for (const legacyOnly of ["ChatticusDns", "ChatticusGitHubDeploy", "ChatticusThinTurnStaging", "ChatticusWebProduction"]) {
      assert.equal(stackIds.includes(legacyOnly), false, legacyOnly);
    }
  });

  it("names development develop.chattic.us and auth-develop.chattic.us, not the legacy names", () => {
    assert.deepEqual(DEDICATED_ACCOUNT_HOSTNAMES.development, {
      siteDomain: "develop.chattic.us",
      authDomain: "auth-develop.chattic.us",
    });
  });

  it("gives each name its own delegated zone, retained and protected", () => {
    const zones = template(app, ENVIRONMENT_ZONES_STACK_ID);
    zones.resourceCountIs("AWS::Route53::HostedZone", 2);
    zones.hasResourceProperties("AWS::Route53::HostedZone", { Name: "develop.chattic.us." });
    zones.hasResourceProperties("AWS::Route53::HostedZone", { Name: "auth-develop.chattic.us." });
    for (const zone of Object.values(zones.findResources("AWS::Route53::HostedZone"))) {
      assert.equal((zone as { DeletionPolicy?: string }).DeletionPolicy, "Retain");
    }
    assert.equal((app.node.findChild(ENVIRONMENT_ZONES_STACK_ID) as cdk.Stack).terminationProtection, true);
    const outputs = zones.toJSON().Outputs as Record<string, unknown>;
    assert.ok("SiteNameServers" in outputs && "AuthNameServers" in outputs);
  });

  it("issues one certificate per name, each validated by DNS in that name's own zone", () => {
    const certificates = template(app, ENVIRONMENT_CERTIFICATES_STACK_ID);
    certificates.resourceCountIs("AWS::CertificateManager::Certificate", 2);
    for (const [domain] of [["develop.chattic.us"], ["auth-develop.chattic.us"]]) {
      certificates.hasResourceProperties("AWS::CertificateManager::Certificate", {
        DomainName: domain,
        ValidationMethod: "DNS",
        DomainValidationOptions: [Match.objectLike({ DomainName: domain })],
      });
    }
    const zoneRefs = Object.values(certificates.findResources("AWS::CertificateManager::Certificate")).map((resource) =>
      JSON.stringify((resource as { Properties: { DomainValidationOptions: Array<{ HostedZoneId: unknown }> } }).Properties.DomainValidationOptions[0].HostedZoneId),
    );
    assert.equal(new Set(zoneRefs).size, 2, "each certificate validates in a different zone");
  });

  it("serves the web site on the new name from its own zone and certificate", () => {
    const web = template(app, "ChatticusWeb");
    web.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({ Aliases: ["develop.chattic.us"] }),
    });
    web.hasResourceProperties("AWS::Route53::RecordSet", { Name: "develop.chattic.us.", Type: "A" });
    web.hasResourceProperties("AWS::Route53::RecordSet", { Name: "develop.chattic.us.", Type: "AAAA" });
  });

  it("serves sign-in on the new auth name, and trusts only the new site's callbacks", () => {
    const auth = template(app, "ChatticusAuth");
    auth.hasResourceProperties("AWS::Cognito::UserPoolDomain", { Domain: "auth-develop.chattic.us" });
    auth.hasResourceProperties("AWS::Route53::RecordSet", { Name: "auth-develop.chattic.us.", Type: "A" });
    auth.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      CallbackURLs: Match.arrayWith(["https://develop.chattic.us/auth/callback"]),
    });
    const json = JSON.stringify(auth.toJSON());
    assert.equal(json.includes("dev.chattic.us"), false, "no legacy dev name leaks into the new auth stack");
  });

  it("wires web to the site zone and site certificate, and auth to the auth zone and auth certificate", () => {
    const importNames = (json: unknown): string[] => {
      const found: string[] = [];
      JSON.stringify(json, (_key, value) => {
        if (value && typeof value === "object" && "Fn::ImportValue" in (value as object)) {
          found.push(String((value as Record<string, unknown>)["Fn::ImportValue"]));
        }
        return value;
      });
      return found;
    };
    const recordZone = (stackId: string, name: string) => {
      const records = Object.values(template(app, stackId).findResources("AWS::Route53::RecordSet", { Properties: { Name: name } }));
      return importNames((records[0] as { Properties: { HostedZoneId: unknown } }).Properties.HostedZoneId);
    };
    const distribution = Object.values(template(app, "ChatticusWeb").findResources("AWS::CloudFront::Distribution"))[0] as {
      Properties: { DistributionConfig: { ViewerCertificate: { AcmCertificateArn: unknown } } };
    };
    const domain = Object.values(template(app, "ChatticusAuth").findResources("AWS::Cognito::UserPoolDomain"))[0] as {
      Properties: { CustomDomainConfig: { CertificateArn: unknown } };
    };
    assert.ok(recordZone("ChatticusWeb", "develop.chattic.us.").every((name) => name.includes("SiteZone")));
    assert.ok(recordZone("ChatticusAuth", "auth-develop.chattic.us.").every((name) => name.includes("AuthZone")));
    assert.ok(importNames(distribution.Properties.DistributionConfig.ViewerCertificate.AcmCertificateArn).every((name) => name.includes("SiteCertificate")));
    assert.ok(importNames(domain.Properties.CustomDomainConfig.CertificateArn).every((name) => name.includes("AuthCertificate")));
    assert.ok(recordZone("ChatticusWeb", "develop.chattic.us.").length > 0);
    assert.ok(importNames(domain.Properties.CustomDomainConfig.CertificateArn).length > 0);
  });

  it("builds the web stack's bundle with the new site's domain", () => {
    const json = JSON.stringify(template(app, "ChatticusWeb").toJSON());
    assert.equal(json.includes("https://dev.chattic.us"), false);
  });
});

describe("the web /api* origin is the control plane in every environment", () => {
  for (const environmentName of CHATTICUS_CLOUD_ENVIRONMENTS) {
    it(`points ${environmentName} CloudFront at the ${CONTROL_PLANE_STACK_IDS[environmentName]} function URL`, () => {
      const app = new cdk.App();
      buildDedicatedAccountStacks(app, {
        env: ENV,
        environmentName,
        websiteDeploySource: stubWebsiteDeploySource,
      });
      const stackIds = app.node.children.filter(cdk.Stack.isStack).map((stack) => stack.node.id);
      assert.ok(stackIds.includes(CONTROL_PLANE_STACK_IDS[environmentName]));
      const distribution = Object.values(
        template(app, WEB_STACK_IDS[environmentName]).findResources("AWS::CloudFront::Distribution"),
      )[0] as { Properties: { DistributionConfig: { Origins: Array<{ DomainName: unknown; CustomOriginConfig?: unknown }> } } };
      const apiOrigin = distribution.Properties.DistributionConfig.Origins.find((origin) => origin.CustomOriginConfig !== undefined);
      assert.ok(apiOrigin);
      const originJson = JSON.stringify(apiOrigin.DomainName);
      assert.ok(originJson.includes(CONTROL_PLANE_STACK_IDS[environmentName]), originJson);
      assert.equal(originJson.includes(THIN_TURN_STACK_IDS[environmentName]), false, originJson);
      const web = app.node.findChild(WEB_STACK_IDS[environmentName]) as cdk.Stack;
      const dependencyIds = web.dependencies.map((dependency) => dependency.node.id);
      assert.ok(dependencyIds.includes(CONTROL_PLANE_STACK_IDS[environmentName]));
      assert.ok(dependencyIds.includes(THIN_TURN_STACK_IDS[environmentName]));
    });
  }

  it("wires the legacy-account app entrypoint to the control plane too", () => {
    const entrypoint = readFileSync(join(__dirname, "..", "bin", "chatticus.ts"), "utf8");
    assert.match(entrypoint, /frontDoorFunctionUrl: controlPlane\.frontDoorFunctionUrl/);
    assert.doesNotMatch(entrypoint, /frontDoorFunctionUrl: thinTurn\.frontDoorFunctionUrl/);
    assert.match(entrypoint, /web\.addDependency\(controlPlane\)/);
  });
});

describe("readDedicatedEnvironment", () => {
  const appWith = (context: Record<string, string>) => new cdk.App({ context });

  it("is undefined when the legacy default applies", () => {
    assert.equal(readDedicatedEnvironment(appWith({})), undefined);
    assert.equal(readDedicatedEnvironment(appWith({ chatticusAccountEnvironment: "" })), undefined);
  });

  it("accepts the three environments and rejects anything else", () => {
    for (const name of ["development", "staging", "production"]) {
      assert.equal(readDedicatedEnvironment(appWith({ chatticusAccountEnvironment: name })), name);
    }
    assert.throws(() => readDedicatedEnvironment(appWith({ chatticusAccountEnvironment: "qa" })), /Unknown chatticusAccountEnvironment/);
  });
});

describe("tags in a dedicated account", () => {
  it("classifies the zone and certificate stacks as dns", () => {
    assert.equal(stackTagsFor(ENVIRONMENT_ZONES_STACK_ID).component, "dns");
    assert.equal(stackTagsFor(ENVIRONMENT_CERTIFICATES_STACK_ID).component, "dns");
  });

  it("gives the account's own environment to stacks that are shared in legacy", () => {
    assert.equal(stackTagsFor("ChatticusSnapshots").environment, "shared");
    assert.equal(stackTagsFor("ChatticusSnapshots", "development").environment, "development");
    assert.equal(stackTagsFor("ChatticusThinTurn", "development").environment, "development");
  });

  it("tags a real dedicated-account stack with its environment", () => {
    const app = buildDevelopment();
    const snapshots = app.node.findChild("ChatticusSnapshots") as cdk.Stack;
    applyStandardTags(snapshots, "Anthus AI Solutions", "development");
    const tags = Template.fromStack(snapshots).toJSON().Resources as Record<string, { Properties?: { Tags?: Array<{ Key: string; Value: string }> } }>;
    const bucketTags = Object.values(tags).find((resource) => resource.Properties?.Tags)?.Properties?.Tags ?? [];
    const environment = bucketTags.find((tag) => tag.Key === "chatticus:environment");
    assert.equal(environment?.Value, "development");
  });
});
