import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SPA_VIEWER_REQUEST_FUNCTION } from "../lib/cloudfront-functions";
import { WEB_CLOUDFRONT_ENABLED, WEB_SITE_DOMAINS } from "../lib/environments";
import { synthWebStack } from "./web-stack-harness";

describe("WebStack CloudFront enabled flag", () => {
  for (const environmentName of ["development", "staging", "production"] as const) {
    it(`sets Enabled for ${environmentName}`, () => {
      const template = synthWebStack(environmentName);
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: {
          Enabled: WEB_CLOUDFRONT_ENABLED[environmentName],
        },
      });
    });
  }

  it("invalidates CloudFront on every BucketDeployment (CachingOptimized defaults to a 24h edge TTL)", () => {
    const template = synthWebStack("development");
    const deployments = template.findResources("Custom::CDKBucketDeployment");
    assert.equal(Object.keys(deployments).length, 1);
    const properties = Object.values(deployments)[0].Properties as {
      DistributionId?: { Ref?: string };
      DistributionPaths?: string[];
    };
    assert.ok(properties.DistributionId, "expected DistributionId to be set");
    assert.deepEqual(properties.DistributionPaths, ["/*"]);
  });

  it("associates SPA viewer-request rewrite on the default behavior", () => {
    const template = synthWebStack("development");
    template.hasResourceProperties("AWS::CloudFront::Function", {
      FunctionCode: SPA_VIEWER_REQUEST_FUNCTION,
    });
    const distributions = template.findResources("AWS::CloudFront::Distribution");
    const defaultBehavior = Object.values(distributions)[0].Properties
      .DistributionConfig.DefaultCacheBehavior as {
      FunctionAssociations: Array<{ EventType: string }>;
    };
    const eventTypes = defaultBehavior.FunctionAssociations.map(
      (association) => association.EventType,
    );
    assert.ok(eventTypes.includes("viewer-request"));
    assert.ok(eventTypes.includes("viewer-response"));
  });
});

describe("WebStack single-domain routing (post marketing split, chatticus-3926bc)", () => {
  for (const environmentName of ["development", "staging", "production"] as const) {
    it(`aliases only ${WEB_SITE_DOMAINS[environmentName]} for ${environmentName}`, () => {
      const template = synthWebStack(environmentName);
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: {
          Aliases: [WEB_SITE_DOMAINS[environmentName]],
        },
      });
    });
  }

  it("does not export MarketingSiteUrl", () => {
    const template = synthWebStack("production");
    const outputs = template.findOutputs("*");
    assert.ok(
      !Object.keys(outputs).includes("MarketingSiteUrl"),
      "MarketingSiteUrl should no longer be exported -- the marketing site has its own distribution now",
    );
  });

  it("creates no apex A/AAAA records for chattic.us", () => {
    const template = synthWebStack("production");
    const records = template.findResources("AWS::Route53::RecordSet");
    const apexRecords = Object.values(records).filter((record) => {
      const properties = record.Properties as { Name?: string };
      return properties.Name === "chattic.us.";
    });
    assert.equal(apexRecords.length, 0);
  });
});
