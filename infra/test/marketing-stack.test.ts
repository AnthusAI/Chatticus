import assert from "node:assert/strict";
import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, it } from "node:test";
import { WWW_TO_APEX_REDIRECT_FUNCTION } from "../lib/cloudfront-functions";
import { MarketingWebStack } from "../lib/marketing-stack";

function synthMarketingStack(): Template {
  const app = new cdk.App();
  const dependencies = new cdk.Stack(app, "Dependencies");
  const hostedZone = route53.HostedZone.fromHostedZoneAttributes(
    dependencies,
    "Zone",
    {
      hostedZoneId: "Z1234567890ABC",
      zoneName: "chattic.us",
    },
  );
  const siteCertificate = acm.Certificate.fromCertificateArn(
    dependencies,
    "Certificate",
    "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000",
  );
  return Template.fromStack(
    new MarketingWebStack(app, "Marketing", { hostedZone, siteCertificate }),
  );
}

describe("MarketingWebStack", () => {
  it("serves the exported Next 404 page without converting missing paths to 200", () => {
    const template = synthMarketingStack();
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        CustomErrorResponses: Match.arrayWith([
          {
            ErrorCode: 403,
            ResponseCode: 404,
            ResponsePagePath: "/404.html",
          },
          {
            ErrorCode: 404,
            ResponseCode: 404,
            ResponsePagePath: "/404.html",
          },
        ]),
      },
    });
    template.resourceCountIs("AWS::CloudFront::Function", 1);
  });

  it("preserves query parameters when redirecting www to the apex", () => {
    const handler = new Function(
      `${WWW_TO_APEX_REDIRECT_FUNCTION}; return handler;`,
    )() as (event: object) => { headers: { location: { value: string } } };
    const response = handler({
      request: {
        uri: "/join",
        headers: { host: { value: "www.chattic.us" } },
        querystring: {
          source: { value: "newsletter" },
          tag: { multiValue: [{ value: "one" }, { value: "two" }] },
        },
      },
    });
    assert.equal(
      response.headers.location.value,
      "https://chattic.us/join?source=newsletter&tag=one&tag=two",
    );
  });
});
