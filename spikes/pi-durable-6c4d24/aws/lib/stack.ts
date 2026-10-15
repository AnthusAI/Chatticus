import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Architecture, Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import { BlockPublicAccess, Bucket } from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

const OPENAI_PARAMETER = "/chatticus/development/thin-turn/openai-api-key";

/** Throwaway: one on-demand table, one bucket, one Lambda. No VPC, nothing with an hourly cost. */
export class PiDurableSpikeStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    const table = new Table(this, "Table", {
      partitionKey: { name: "pk", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    for (const name of ["l1", "l2", "l3"]) {
      table.addLocalSecondaryIndex({
        indexName: `${name}-index`,
        sortKey: { name, type: AttributeType.STRING },
      });
    }
    const bucket = new Bucket(this, "Bucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const handler = new LambdaFunction(this, "Owner", {
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      handler: "handler.handler",
      code: Code.fromAsset("build/lambda"),
      memorySize: 1024,
      timeout: Duration.seconds(120),
      logRetention: RetentionDays.ONE_DAY,
      environment: {
        TABLE_NAME: table.tableName,
        BUCKET_NAME: bucket.bucketName,
        OPENAI_API_KEY_PARAMETER: OPENAI_PARAMETER,
        MODEL_ID: "gpt-5-nano",
      },
    });
    table.grantReadWriteData(handler);
    bucket.grantReadWrite(handler);
    handler.addToRolePolicy(
      new PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [this.formatArn({ service: "ssm", resource: "parameter", resourceName: OPENAI_PARAMETER.slice(1) })],
      }),
    );
    new CfnOutput(this, "FunctionName", { value: handler.functionName });
    new CfnOutput(this, "TableName", { value: table.tableName });
    new CfnOutput(this, "BucketName", { value: bucket.bucketName });
  }
}
