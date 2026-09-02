import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildSpaViewerRequestFunction } from "../lib/cloudfront-functions";
import { WEB_CLOUDFRONT_ENABLED } from "../lib/environments";
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

  it("does not tie BucketDeployment to CloudFront invalidation", () => {
    const template = synthWebStack("development");
    const deployments = template.findResources("Custom::CDKBucketDeployment");
    assert.equal(Object.keys(deployments).length, 1);
    const properties = Object.values(deployments)[0].Properties as {
      DistributionId?: string;
      DistributionPaths?: string[];
    };
    assert.equal(properties.DistributionId, undefined);
    assert.equal(properties.DistributionPaths, undefined);
  });

  it("associates SPA viewer-request rewrite on the default behavior", () => {
    const template = synthWebStack("development");
    template.hasResourceProperties("AWS::CloudFront::Function", {
      FunctionCode: buildSpaViewerRequestFunction(),
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

describe("WebStack production two-domain routing", () => {
  it("aliases both hey.chattic.us and chattic.us on one distribution", () => {
    const template = synthWebStack("production");
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        Aliases: ["hey.chattic.us", "chattic.us"],
      },
    });
  });

  it("embeds Host-based routing in the production viewer-request function", () => {
    const template = synthWebStack("production");
    template.hasResourceProperties("AWS::CloudFront::Function", {
      FunctionCode: buildSpaViewerRequestFunction({
        appDomain: "hey.chattic.us",
        marketingDomain: "chattic.us",
      }),
    });
  });

  it("creates apex A and AAAA records for chattic.us", () => {
    const template = synthWebStack("production");
    const records = template.findResources("AWS::Route53::RecordSet");
    const apexARecords = Object.values(records).filter((record) => {
      const properties = record.Properties as { Name?: string; Type?: string };
      return properties.Name === "chattic.us." && properties.Type === "A";
    });
    assert.equal(apexARecords.length, 1);
    const apexAaaaRecords = Object.values(records).filter((record) => {
      const properties = record.Properties as { Name?: string; Type?: string };
      return properties.Name === "chattic.us." && properties.Type === "AAAA";
    });
    assert.equal(apexAaaaRecords.length, 1);
  });

  it("exports MarketingSiteUrl for production", () => {
    const template = synthWebStack("production");
    template.hasOutput("MarketingSiteUrl", {
      Value: "https://chattic.us",
    });
  });
});
