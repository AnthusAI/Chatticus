import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { execSync } from "child_process";
import * as path from "path";
import { Construct } from "constructs";
import { API_ORIGIN_VIEWER_REQUEST_FUNCTION, SPA_VIEWER_REQUEST_FUNCTION, SPA_VIEWER_RESPONSE_FUNCTION } from "./cloudfront-functions";
import {
  ChatticusCloudEnvironment,
  thinTurnParameterPrefix,
  WEB_CLOUDFRONT_ENABLED,
  webParameterPrefix,
  WEB_SITE_DOMAINS,
} from "./environments";
import {
  CHATTICUS_LOG_RETENTION,
  CustomResourceProviderLogRetentionAspect,
} from "./log-retention";
import { webDockerBundleCommand, webLocalBundleCommand, WEB_BUNDLE_DOCKER_IMAGE, WEB_LOCAL_BUNDLE_AWS_CLI_CHECK } from "./web-build-env";

export interface WebStackProps extends cdk.StackProps {
  chatticusEnvironment: ChatticusCloudEnvironment;
  hostedZone: route53.IHostedZone;
  siteCertificate: acm.ICertificate;
  frontDoorFunctionUrl: lambda.IFunctionUrl;
  invokeSecret: secretsmanager.ISecret;
  /**
   * Override the website deploy source (unit tests only). Production deploys
   * omit this and bundle the Next.js site from ``web/``.
   */
  websiteDeploySource?: s3deploy.ISource;
}

/**
 * Next.js static site on S3 with same-origin /api/* proxy to the thin-turn
 * proxy to the thin-turn Lambda function URL.
 *
 * CloudFront path ``/api*`` (not ``/api/*``) so nested routes like
 * ``/api/turns/{id}/claim`` reach the API origin instead of S3.
 */
export class WebStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    const environmentName = props.chatticusEnvironment;
    const siteDomain = WEB_SITE_DOMAINS[environmentName];
    const webPrefix = webParameterPrefix(environmentName);
    const thinTurnPrefix = thinTurnParameterPrefix(environmentName);
    const retainData = environmentName !== "development";
    cdk.Tags.of(this).add("chatticus:environment", environmentName);
    if (!retainData) {
      cdk.Aspects.of(this).add(
        new CustomResourceProviderLogRetentionAspect(CHATTICUS_LOG_RETENTION),
      );
    }

    const invokeSecret = props.invokeSecret;
    const frontDoorFunctionUrl = props.frontDoorFunctionUrl;

    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: retainData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !retainData,
    });

    const originReadTimeoutSeconds = 60;
    const apiOriginViewerRequest = new cloudfront.Function(this, "ApiOriginViewerRequest", {
      code: cloudfront.FunctionCode.fromInline(API_ORIGIN_VIEWER_REQUEST_FUNCTION),
      comment: "Strip /api prefix and Accept-Encoding for the Lambda origin.",
    });
    const spaViewerRequest = new cloudfront.Function(this, "SpaViewerRequest", {
      code: cloudfront.FunctionCode.fromInline(SPA_VIEWER_REQUEST_FUNCTION),
      comment: "Rewrite slashless SPA paths (OAuth callback) before S3 lookup.",
    });
    const spaViewerResponse = new cloudfront.Function(this, "SpaViewerResponse", {
      code: cloudfront.FunctionCode.fromInline(SPA_VIEWER_RESPONSE_FUNCTION),
      comment: "SPA fallback status for S3 paths; never rewrite /api responses.",
    });

    const distribution = new cloudfront.Distribution(this, "SiteDistribution", {
      enabled: WEB_CLOUDFRONT_ENABLED[environmentName],
      comment: `Chatticus ${environmentName} web UI and same-origin /api front door.`,
      domainNames: [siteDomain],
      certificate: props.siteCertificate,
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [
          {
            function: spaViewerRequest,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
          {
            function: spaViewerResponse,
            eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE,
          },
        ],
      },
      additionalBehaviors: {
        "/api*": {
          origin: new origins.FunctionUrlOrigin(frontDoorFunctionUrl, {
            readTimeout: cdk.Duration.seconds(originReadTimeoutSeconds),
            responseCompletionTimeout: cdk.Duration.seconds(900),
            customHeaders: {
              "X-Chatticus-Invoke-Key": invokeSecret.secretValue.unsafeUnwrap(),
            },
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy:
            cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          functionAssociations: [
            {
              function: apiOriginViewerRequest,
              eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            },
          ],
        },
      },
    });

    const webRoot = path.join(__dirname, "../../web");
    const websiteSources = props.websiteDeploySource
      ? [props.websiteDeploySource]
      : [
          s3deploy.Source.asset(webRoot, {
            bundling: {
              image: cdk.DockerImage.fromRegistry(WEB_BUNDLE_DOCKER_IMAGE),
              command: ["bash", "-c", webDockerBundleCommand(environmentName)],
              local: {
                tryBundle(outputDir: string): boolean {
                  try {
                    execSync(
                      `${WEB_LOCAL_BUNDLE_AWS_CLI_CHECK} && ${webLocalBundleCommand(environmentName)}`,
                      {
                        cwd: webRoot,
                        stdio: "inherit",
                        shell: "/bin/bash",
                      },
                    );
                    execSync(`cp -r ${webRoot}/out/. ${outputDir}/`, {
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
        ];
    new s3deploy.BucketDeployment(this, "DeployWebsite", {
      logRetention: CHATTICUS_LOG_RETENTION,
      sources: websiteSources,
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ["/*"],
    });

    new route53.ARecord(this, "SiteAliasRecord", {
      zone: props.hostedZone,
      recordName: siteDomain,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(distribution),
      ),
    });
    new route53.AaaaRecord(this, "SiteAliasRecordV6", {
      zone: props.hostedZone,
      recordName: siteDomain,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(distribution),
      ),
    });

    const siteUrl = `https://${siteDomain}`;
    const apiBaseUrl = `${siteUrl}/api`;

    new ssm.StringParameter(this, "SiteUrlParameter", {
      parameterName: `${webPrefix}/site-url`,
      stringValue: siteUrl,
      description: `Public site URL for the ${environmentName} Next.js UI.`,
    });
    new ssm.StringParameter(this, "CloudFrontDistributionIdParameter", {
      parameterName: `${webPrefix}/cloudfront-distribution-id`,
      stringValue: distribution.distributionId,
      description: `CloudFront distribution id for the ${environmentName} unified site.`,
    });
    new ssm.StringParameter(this, "ThinTurnCloudFrontUrlParameter", {
      parameterName: `${thinTurnPrefix}/cloudfront-url`,
      stringValue: apiBaseUrl,
      description:
        `Same-origin API base URL for the ${environmentName} thin-turn front door.`,
    });

    new cdk.CfnOutput(this, "ChatticusEnvironment", { value: environmentName });
    new cdk.CfnOutput(this, "SiteDomain", { value: siteDomain });
    new cdk.CfnOutput(this, "SiteUrl", { value: siteUrl });
    new cdk.CfnOutput(this, "ApiBaseUrl", { value: apiBaseUrl });
    new cdk.CfnOutput(this, "CloudFrontUrl", { value: siteUrl });
    new cdk.CfnOutput(this, "CloudFrontDistributionDomainName", {
      value: distribution.distributionDomainName,
    });
  }
}
