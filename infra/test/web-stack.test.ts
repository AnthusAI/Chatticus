import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SPA_VIEWER_REQUEST_FUNCTION } from "../lib/cloudfront-functions";
import { synthWebStack } from "./web-stack-harness";

describe("WebStack CloudFront enabled flag", () => {
  for (const environmentName of ["development", "staging", "production"] as const) {
    it(`sets Enabled for ${environmentName}`, () => {
      const template = synthWebStack(environmentName);
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: {
          Enabled: environmentName === "development",
        },
      });
    });
  }

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
