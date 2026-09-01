import { IAspect } from "aws-cdk-lib";
import * as cdk from "aws-cdk-lib";
import * as logs from "aws-cdk-lib/aws-logs";
import { IConstruct } from "constructs";

/**
 * CloudWatch log retention for every Chatticus log group.
 *
 * DynamoDB is the system of record; logs are a 30-day debug window long
 * enough for incident lookback and short enough to bound storage cost.
 */
export const CHATTICUS_LOG_RETENTION = logs.RetentionDays.ONE_MONTH;

const CUSTOM_RESOURCE_PROVIDER_METADATA =
  "aws:cdk:is-custom-resource-handler-customResourceProvider";

interface CustomResourceProviderHandler {
  readonly handler?: cdk.CfnResource;
}

/**
 * Apply retention to custom-resource provider Lambdas (e.g. S3 auto-delete).
 *
 * CDK providers tag themselves with {@link CUSTOM_RESOURCE_PROVIDER_METADATA}
 * and expose the handler as a Cfn Lambda resource. Log group names are derived
 * from the handler Ref token, not a hardcoded physical name.
 */
export class CustomResourceProviderLogRetentionAspect implements IAspect {
  constructor(private readonly retentionDays: logs.RetentionDays) {}

  visit(node: IConstruct): void {
    const isProvider = node.node.metadata.some(
      (entry) => entry.type === CUSTOM_RESOURCE_PROVIDER_METADATA,
    );
    if (!isProvider) {
      return;
    }

    const handler = (node as CustomResourceProviderHandler).handler;
    if (!handler || node.node.tryFindChild("LogRetention")) {
      return;
    }

    new logs.LogRetention(node, "LogRetention", {
      logGroupName: `/aws/lambda/${handler.ref}`,
      retention: this.retentionDays,
    });
  }
}
