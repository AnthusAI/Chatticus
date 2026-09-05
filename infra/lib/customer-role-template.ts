import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import type { ChatticusCloudEnvironment } from "./environments";

/** S3 object key for the published cross-account CloudFormation template. */
export const CUSTOMER_ROLE_TEMPLATE_OBJECT_KEY = "provisioning/customer-role.yml";

/** Repo-relative path to the single source template (never duplicate this file). */
export const CUSTOMER_ROLE_TEMPLATE_REPO_PATH = "infra/customer-role.yml";

export function provisioningParameterPrefix(
  environment: ChatticusCloudEnvironment,
): string {
  return `/chatticus/${environment}/provisioning`;
}

export function customerRoleTemplateUrl(siteDomain: string): string {
  return `https://${siteDomain}/${CUSTOMER_ROLE_TEMPLATE_OBJECT_KEY}`;
}

/**
 * Deploy source for the customer cross-account role template.
 *
 * Reads ``infra/customer-role.yml`` at synth/deploy time. S3 may serve the
 * object as ``application/octet-stream``; CloudFormation accepts HTTPS GET.
 */
export function customerRoleTemplateDeploySource(repoRoot: string): s3deploy.ISource {
  const templatePath = path.join(repoRoot, CUSTOMER_ROLE_TEMPLATE_REPO_PATH);
  const data = readFileSync(templatePath, "utf8");
  return s3deploy.Source.data(CUSTOMER_ROLE_TEMPLATE_OBJECT_KEY, data);
}
