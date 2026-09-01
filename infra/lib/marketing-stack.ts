import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { execSync } from "child_process";
import * as path from "path";
import { Construct } from "constructs";
import {
  WWW_TO_APEX_REDIRECT_FUNCTION,
} from "./cloudfront-functions";
import {
  MARKETING_SITE_DOMAIN,
  MARKETING_WWW_DOMAIN,
  webParameterPrefix,
} from "./environments";

export interface MarketingWebStackProps extends cdk.StackProps {
  hostedZone: route53.IHostedZone;
  siteCertificate: acm.ICertificate;
}

export class MarketingWebStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MarketingWebStackProps) {
    super(scope, id, props);

    const siteDomain = MARKETING_SITE_DOMAIN;
    const webPrefix = webParameterPrefix("production");

    const siteBucket = new s3.Bucket(this, "MarketingBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const wwwRedirect = new cloudfront.Function(this, "WwwToApexRedirect", {
      code: cloudfront.FunctionCode.fromInline(WWW_TO_APEX_REDIRECT_FUNCTION),
      comment: "Redirect www.chattic.us to the marketing site apex.",
    });
    const distribution = new cloudfront.Distribution(this, "MarketingDistribution", {
      comment: "Chatticus public marketing site at chattic.us.",
      domainNames: [siteDomain, MARKETING_WWW_DOMAIN],
      certificate: props.siteCertificate,
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [
          {
            function: wwwRedirect,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 404,
          responsePagePath: "/404.html",
        },
        {
          httpStatus: 404,
          responseHttpStatus: 404,
          responsePagePath: "/404.html",
        },
      ],
    });

    const marketingRoot = path.join(__dirname, "../../marketing");
    new s3deploy.BucketDeployment(this, "DeployMarketing", {
      sources: [
        s3deploy.Source.asset(marketingRoot, {
          bundling: {
            image: cdk.DockerImage.fromRegistry("node:22-bookworm-slim"),
            command: [
              "bash",
              "-c",
              [
                "cd /asset-input",
                "npm ci",
                "npm run build",
                "cp -r out/. /asset-output/",
              ].join(" && "),
            ],
            local: {
              tryBundle(outputDir: string): boolean {
                try {
                  execSync("npm ci && npm run build", {
                    cwd: marketingRoot,
                    stdio: "inherit",
                  });
                  execSync(`cp -r ${marketingRoot}/out/. ${outputDir}/`, {
                    stdio: "inherit",
                  });
                  return true;
                } catch {
                  return false;
                }
              },
            },
          },
        }),
      ],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ["/*"],
    });

    new route53.ARecord(this, "MarketingAliasRecord", {
      zone: props.hostedZone,
      recordName: siteDomain,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(distribution),
      ),
    });
    new route53.AaaaRecord(this, "MarketingAliasRecordV6", {
      zone: props.hostedZone,
      recordName: siteDomain,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(distribution),
      ),
    });
    new route53.ARecord(this, "WwwAliasRecord", {
      zone: props.hostedZone,
      recordName: "www",
      target: route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(distribution),
      ),
    });
    new route53.AaaaRecord(this, "WwwAliasRecordV6", {
      zone: props.hostedZone,
      recordName: "www",
      target: route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(distribution),
      ),
    });

    const siteUrl = `https://${siteDomain}`;
    new ssm.StringParameter(this, "MarketingSiteUrlParameter", {
      parameterName: `${webPrefix}/marketing-site-url`,
      stringValue: siteUrl,
      description: "Public Chatticus marketing site URL.",
    });

    new cdk.CfnOutput(this, "MarketingSiteUrl", { value: siteUrl });
    new cdk.CfnOutput(this, "MarketingSiteDomain", { value: siteDomain });
    new cdk.CfnOutput(this, "CloudFrontDistributionDomainName", {
      value: distribution.distributionDomainName,
    });
  }
}
