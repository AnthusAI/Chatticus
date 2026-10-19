import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { SPA_VIEWER_REQUEST_FUNCTION } from "../lib/cloudfront-functions";
import {
  CUSTOMER_ROLE_TEMPLATE_OBJECT_KEY,
  provisioningParameterPrefix,
} from "../lib/customer-role-template";
import {
  WEB_CLOUDFRONT_ENABLED,
  WEB_CROSS_ORIGIN_ISOLATION,
  ENVIRONMENT_HOSTNAMES,
} from "../lib/environments"
import {
  deployWebsiteAssets,
  listAssetRelativeFiles,
  type AssetManifest,
} from "./deploy-website-assets";
import {
  synthWebStack,
  synthWebStackWithAssets,
  synthWebStackWithInvokeKeyVersion,
} from "./web-stack-harness";

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

  it("DeployWebsite ships SPA and customer-role template in one BucketDeployment", () => {
    const { template, cdkOutDir, stackId } = synthWebStackWithAssets("development");
    const deployments = template.findResources("Custom::CDKBucketDeployment");
    assert.equal(Object.keys(deployments).length, 1);

    const properties = Object.values(deployments)[0].Properties as {
      SourceObjectKeys?: string[];
    };
    assert.ok(properties.SourceObjectKeys, "expected SourceObjectKeys on DeployWebsite");
    assert.equal(
      properties.SourceObjectKeys.length,
      2,
      "SPA source and customer-role yaml must share one deployment",
    );

    const manifest = JSON.parse(
      readFileSync(join(cdkOutDir, `${stackId}.assets.json`), "utf8"),
    ) as AssetManifest;
    const deployAssets = deployWebsiteAssets(manifest);
    assert.equal(deployAssets.length, 2);

    const spaAsset = deployAssets.find((asset) => asset.displayName === "DeployWebsite/Asset1");
    const templateAsset = deployAssets.find((asset) => asset.displayName === "DeployWebsite/Asset2");
    assert.ok(spaAsset, "expected stub SPA as DeployWebsite/Asset1");
    assert.ok(templateAsset, "expected customer-role yaml as DeployWebsite/Asset2");

    const spaFiles = listAssetRelativeFiles(cdkOutDir, spaAsset.source.path);
    const templateFiles = listAssetRelativeFiles(cdkOutDir, templateAsset.source.path);

    assert.deepEqual(spaFiles, ["index.html"], "stub SPA survived; yaml did not replace it");
    assert.ok(
      !spaFiles.some((file) => file.includes("customer-role")),
      "SPA asset must not bundle customer-role.yml",
    );

    assert.deepEqual(templateFiles, [CUSTOMER_ROLE_TEMPLATE_OBJECT_KEY]);
    assert.ok(
      !templateFiles.includes("customer-role.yml"),
      "customer-role.yml must live under provisioning/, not zip root",
    );
  });

  for (const environmentName of ["development", "staging", "production"] as const) {
    it(`publishes customer-role.yml at a stable URL for ${environmentName}`, () => {
      const template = synthWebStack(environmentName);
      const siteDomain = ENVIRONMENT_HOSTNAMES[environmentName].siteDomain;
      const templateUrl = `https://${siteDomain}/provisioning/customer-role.yml`;
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: `${provisioningParameterPrefix(environmentName)}/customer-role-template-url`,
        Value: templateUrl,
      });
      template.hasOutput("CustomerRoleTemplateUrl", {
        Value: templateUrl,
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

describe("WebStack single-domain routing (post marketing split, chatticus-3926bc)", () => {
  for (const environmentName of ["development", "staging", "production"] as const) {
    it(`aliases only ${ENVIRONMENT_HOSTNAMES[environmentName].siteDomain} for ${environmentName}`, () => {
      const template = synthWebStack(environmentName);
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: {
          Aliases: [ENVIRONMENT_HOSTNAMES[environmentName].siteDomain],
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

describe("WebStack response headers", () => {
  function customHeaderItems(template: ReturnType<typeof synthWebStack>) {
    const [policy] = Object.values(template.findResources("AWS::CloudFront::ResponseHeadersPolicy"));
    return (policy.Properties as {
      ResponseHeadersPolicyConfig: { CustomHeadersConfig: { Items: { Header: string; Value: string; Override: boolean }[] } };
    }).ResponseHeadersPolicyConfig.CustomHeadersConfig.Items;
  }

  for (const environmentName of ["development", "staging", "production"] as const) {
    it(`${WEB_CROSS_ORIGIN_ISOLATION[environmentName] ? "isolates" : "does not isolate"} ${environmentName}`, () => {
      const template = synthWebStack(environmentName);
      const headerNames = customHeaderItems(template).map((item) => item.Header);
      assert.equal(headerNames.includes("Cross-Origin-Opener-Policy"), WEB_CROSS_ORIGIN_ISOLATION[environmentName]);
      assert.equal(headerNames.includes("Cross-Origin-Embedder-Policy"), WEB_CROSS_ORIGIN_ISOLATION[environmentName]);
      const distribution = Object.values(
        template.findResources("AWS::CloudFront::Distribution"),
      )[0] as { Properties: { DistributionConfig: { DefaultCacheBehavior: { ResponseHeadersPolicyId?: unknown } } } };
      assert.ok(distribution.Properties.DistributionConfig.DefaultCacheBehavior.ResponseHeadersPolicyId);
    });

    it(`sends a report-only content security policy for ${environmentName}`, () => {
      const items = customHeaderItems(synthWebStack(environmentName));
      const policyItem = items.find((item) => item.Header === "Content-Security-Policy-Report-Only");
      assert.ok(policyItem, "report-only CSP header present");
      assert.equal(policyItem.Override, true);
      assert.equal(items.some((item) => item.Header === "Content-Security-Policy"), false);
      const directives = new Map(
        policyItem.Value.split("; ").map((directive) => {
          const [name, ...sources] = directive.split(" ");
          return [name, sources] as const;
        }),
      );
      assert.deepEqual(directives.get("default-src"), ["'self'"]);
      assert.ok(directives.get("worker-src")?.includes("blob:"));
      assert.ok(directives.get("script-src")?.includes("'wasm-unsafe-eval'"));
      assert.ok(directives.get("connect-src")?.includes("https://cognito-idp.us-east-1.amazonaws.com"));
      assert.ok(directives.get("connect-src")?.includes(`https://${ENVIRONMENT_HOSTNAMES[environmentName].authDomain}`));
      assert.deepEqual(directives.get("object-src"), ["'none'"]);
      assert.deepEqual(directives.get("frame-ancestors"), ["'none'"]);
    });
  }
});

describe("WebStack invoke key origin header", () => {
  const VERSION_ID = "11111111-2222-3333-4444-555555555555";

  function originHeaderValue(template: ReturnType<typeof synthWebStack>): string {
    const [distribution] = Object.values(template.findResources("AWS::CloudFront::Distribution"));
    const origins = (distribution.Properties as { DistributionConfig: { Origins: { OriginCustomHeaders?: { HeaderName: string; HeaderValue: unknown }[] }[] } })
      .DistributionConfig.Origins;
    const header = origins
      .flatMap((origin) => origin.OriginCustomHeaders ?? [])
      .find((candidate) => candidate.HeaderName === "X-Chatticus-Invoke-Key");
    assert.ok(header, "no X-Chatticus-Invoke-Key origin header");
    return JSON.stringify(header.HeaderValue);
  }

  it("pins the secret version named in the invokeKeyVersionId context, so a rotation changes the template and CloudFormation resolves the new value", () => {
    const pinned = originHeaderValue(synthWebStackWithInvokeKeyVersion("development", VERSION_ID));
    assert.match(pinned, new RegExp(`SecretString:::${VERSION_ID}`));
    assert.notEqual(pinned, originHeaderValue(synthWebStackWithInvokeKeyVersion("development", "99999999-2222-3333-4444-555555555555")));
  });

  it("follows the current version of the secret when no version is named", () => {
    assert.doesNotMatch(originHeaderValue(synthWebStack("development")), /SecretString:::[0-9a-f]/);
  });
});
