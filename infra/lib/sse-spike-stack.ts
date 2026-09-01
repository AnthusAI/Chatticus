import * as cdk from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { Construct } from "constructs";
import { CHATTICUS_LOG_RETENTION } from "./log-retention";

const STRIP_ACCEPT_ENCODING_FUNCTION = `function handler(event) {
  var request = event.request;
  if (request.headers["accept-encoding"]) {
    delete request.headers["accept-encoding"];
  }
  return request;
}`;

const LAMBDA_WEB_ADAPTER_LAYER_VERSION = 28;

/**
 * Throwaway stack for Test 1: Lambda response streaming plus CloudFront SSE.
 *
 * Destroy with ``cdk destroy ChatticusSseSpike`` when the spike is finished.
 */
export class SseSpikeStack extends cdk.Stack {
  public readonly functionUrl: string;
  public readonly cloudFrontUrl: string;
  public readonly originReadTimeoutSeconds: number;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const lambdaSourcePath = path.join(__dirname, "../../spikes/sse-transport/lambda");
    const lambdaWebAdapterLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      "LambdaWebAdapterLayer",
      `arn:aws:lambda:${this.region}:753240598075:layer:LambdaAdapterLayerX86:${LAMBDA_WEB_ADAPTER_LAYER_VERSION}`,
    );

    const sseFunction = new lambda.Function(this, "SseSpikeFunction", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "run.sh",
      architecture: lambda.Architecture.X86_64,
      memorySize: 256,
      logRetention: CHATTICUS_LOG_RETENTION,
      timeout: cdk.Duration.seconds(900),
      layers: [lambdaWebAdapterLayer],
      description:
        "Throwaway Python SSE spike using Lambda Web Adapter response streaming.",
      environment: {
        AWS_LAMBDA_EXEC_WRAPPER: "/opt/bootstrap",
        AWS_LWA_INVOKE_MODE: "response_stream",
        AWS_LWA_PORT: "8080",
        AWS_LWA_READINESS_CHECK_PATH: "/health",
      },
      code: lambda.Code.fromAsset(lambdaSourcePath, {
        bundling: {
          image: lambda.Runtime.PYTHON_3_12.bundlingImage,
          command: [
            "bash",
            "-c",
            "pip install -r requirements.txt -t /asset-output && cp app.py run.sh /asset-output/ && chmod +x /asset-output/run.sh",
          ],
          local: {
            tryBundle(outputDir: string): boolean {
              try {
                execSync(`pip install -r requirements.txt -t ${outputDir}`, {
                  cwd: lambdaSourcePath,
                  stdio: "inherit",
                });
                fs.copyFileSync(path.join(lambdaSourcePath, "app.py"), path.join(outputDir, "app.py"));
                fs.copyFileSync(path.join(lambdaSourcePath, "run.sh"), path.join(outputDir, "run.sh"));
                fs.chmodSync(path.join(outputDir, "run.sh"), 0o755);
                return true;
              } catch {
                return false;
              }
            },
          },
        },
      }),
    });

    const functionUrl = sseFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
      cors: {
        allowedOrigins: ["*"],
        allowedMethods: [lambda.HttpMethod.GET],
        allowedHeaders: ["last-event-id", "cache-control"],
        exposedHeaders: ["*"],
      },
    });

    const stripAcceptEncoding = new cloudfront.Function(this, "StripAcceptEncoding", {
      code: cloudfront.FunctionCode.fromInline(STRIP_ACCEPT_ENCODING_FUNCTION),
      comment: "Strip Accept-Encoding so the Lambda origin emits identity encoding.",
    });

    const originReadTimeoutSeconds = this.resolveOriginReadTimeoutSeconds();

    const distribution = new cloudfront.Distribution(this, "SseSpikeDistribution", {
      comment: "Throwaway CloudFront distribution for the SSE transport spike.",
      defaultBehavior: {
        origin: new origins.FunctionUrlOrigin(functionUrl, {
          readTimeout: cdk.Duration.seconds(originReadTimeoutSeconds),
          responseCompletionTimeout: cdk.Duration.seconds(900),
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        functionAssociations: [
          {
            function: stripAcceptEncoding,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
    });

    this.functionUrl = `${functionUrl.url}stream`;
    this.cloudFrontUrl = `https://${distribution.distributionDomainName}/stream`;
    this.originReadTimeoutSeconds = originReadTimeoutSeconds;

    new cdk.CfnOutput(this, "SseSpikeFunctionUrl", {
      value: this.functionUrl,
      description: "Direct Lambda function URL for the SSE spike (/stream).",
    });
    new cdk.CfnOutput(this, "SseSpikeCloudFrontUrl", {
      value: this.cloudFrontUrl,
      description: "CloudFront URL for the SSE spike (/stream).",
    });
    new cdk.CfnOutput(this, "SseSpikeOriginReadTimeoutSeconds", {
      value: String(originReadTimeoutSeconds),
      description: "CloudFront origin read timeout applied to the spike distribution.",
    });
  }

  private resolveOriginReadTimeoutSeconds(): number {
    const requested = Number(this.node.tryGetContext("sseOriginReadTimeoutSeconds") ?? 60);
    if (requested > 180 || requested < 1) {
      throw new Error(
        "sseOriginReadTimeoutSeconds must be between 1 and 180 for the SSE spike stack.",
      );
    }
    return requested;
  }
}
