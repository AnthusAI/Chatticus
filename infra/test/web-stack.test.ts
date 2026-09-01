import {
  CHATTICUS_CLOUD_ENVIRONMENTS,
  WEB_CLOUDFRONT_ENABLED,
} from "../lib/environments";
import { describe, it } from "node:test";
import { synthWebStack } from "./web-stack-harness";

describe("WebStack CloudFront enabled flag", () => {
  for (const environmentName of CHATTICUS_CLOUD_ENVIRONMENTS) {
    it(`sets Enabled=${WEB_CLOUDFRONT_ENABLED[environmentName]} for ${environmentName}`, () => {
      const template = synthWebStack(environmentName);
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: {
          Enabled: WEB_CLOUDFRONT_ENABLED[environmentName],
        },
      });
    });
  }
});
