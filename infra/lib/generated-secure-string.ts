import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as customResources from "aws-cdk-lib/custom-resources";
import * as path from "path";
import { Construct } from "constructs";
import { CHATTICUS_LOG_RETENTION } from "./log-retention";

/** The resource type CloudFormation shows for the custom resource of a {@link GeneratedSecureString}. */
export const GENERATED_SECURE_STRING_RESOURCE_TYPE = "Custom::GeneratedSecureString";

/** Properties of a {@link GeneratedSecureString}. */
export interface GeneratedSecureStringProps {
  /** The absolute SSM parameter name, for example `/chatticus/development/thin-turn/operator-key`. */
  readonly parameterName: string;
  /** Characters of the generated key; at least 32. */
  readonly valueLength: number;
  /** What the parameter is for; shown in the Parameter Store console. */
  readonly description?: string;
}

/**
 * A random key that infrastructure code creates once as an SSM Parameter Store standard SecureString under the default
 * aws/ssm key, so nobody types a generated key by hand and the key never appears in a template.
 *
 * A Provider-framework custom resource backed by one small Lambda. Create generates the key with `crypto.randomBytes` and
 * writes it with overwrite off; a parameter that already exists is adopted unchanged. Update and Delete do nothing, and the
 * resource is retained, so a later deploy never changes the key. The answer to CloudFormation carries the parameter name
 * and a version, never the value. The Lambda role may only write the one parameter, and with the AWS managed key it needs
 * no KMS grant. Readers of the key get `ssm:GetParameter` on {@link parameterArn} from the stack that wires them.
 *
 * `AwsCustomResource` is not used because its parameters, the value among them, would be written into the template, and
 * `ssm-secure` dynamic references are not supported inside custom resources.
 */
export class GeneratedSecureString extends Construct {
  /** The absolute SSM parameter name. */
  readonly parameterName: string;
  /** The ARN of the parameter in the account and region of the stack. */
  readonly parameterArn: string;
  /** The Lambda that writes the parameter; its role holds `ssm:PutParameter` on {@link parameterArn} and nothing else. */
  readonly writerFunction: lambdaNodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: GeneratedSecureStringProps) {
    super(scope, id);
    this.parameterName = props.parameterName;
    this.parameterArn = cdk.Stack.of(this).formatArn({
      service: "ssm",
      resource: "parameter",
      resourceName: props.parameterName.replace(/^\//, ""),
    });

    this.writerFunction = new lambdaNodejs.NodejsFunction(this, "Writer", {
      entry: path.join(__dirname, "../../conversation/src/lambdas/generated-secure-string.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 128,
      timeout: cdk.Duration.seconds(30),
      logRetention: CHATTICUS_LOG_RETENTION,
      description: `Writes the generated SecureString ${props.parameterName} once and never shows its value.`,
      bundling: { target: "node22", sourceMap: true, externalModules: [] },
    });
    this.writerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:PutParameter"],
        resources: [this.parameterArn],
      }),
    );

    const provider = new customResources.Provider(this, "Provider", {
      onEventHandler: this.writerFunction,
      logRetention: CHATTICUS_LOG_RETENTION,
    });

    const resource = new cdk.CustomResource(this, "Resource", {
      serviceToken: provider.serviceToken,
      resourceType: GENERATED_SECURE_STRING_RESOURCE_TYPE,
      properties: {
        ParameterName: props.parameterName,
        ValueLength: props.valueLength,
        ...(props.description === undefined ? {} : { Description: props.description }),
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    resource.node.addDependency(this.writerFunction);
  }
}
