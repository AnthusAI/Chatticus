import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as path from "path";
import { Construct } from "constructs";
import { CHATTICUS_LOG_RETENTION } from "./log-retention";

const CREATE_REQUIRE_BANNER =
  'import { createRequire as topLevelCreateRequire } from "module"; ' +
  "const require = topLevelCreateRequire(import.meta.url);";

/**
 * Unrouted prototype of the TypeScript front door: a Hono app behind a
 * Lambda Function URL in RESPONSE_STREAM mode. It is deliberately not
 * attached to CloudFront routing.
 */
export class FrontDoorPrototype extends Construct {
  readonly function: lambdaNodejs.NodejsFunction;
  readonly functionUrl: lambda.FunctionUrl;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.function = new lambdaNodejs.NodejsFunction(this, "Function", {
      entry: path.join(__dirname, "../../conversation/src/lambdas/front-door.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(900),
      logRetention: CHATTICUS_LOG_RETENTION,
      description: "Prototype: Hono SSE through a RESPONSE_STREAM Function URL.",
      bundling: {
        format: lambdaNodejs.OutputFormat.ESM,
        target: "node22",
        mainFields: ["module", "main"],
        sourceMap: true,
        banner: CREATE_REQUIRE_BANNER,
        externalModules: [],
      },
    });
    this.functionUrl = this.function.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    });
  }
}
