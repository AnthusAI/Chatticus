import * as cdk from "aws-cdk-lib";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { AuthStack } from "./auth-stack";
import { BudgetsStack } from "./budgets-stack";
import type { BudgetsConfig } from "./budgets-config";
import { ComputerStack } from "./computer-stack";
import { EnvironmentCertificatesStack } from "./environment-certificates-stack";
import { EnvironmentZonesStack } from "./environment-zones-stack";
import {
  AUTH_STACK_IDS,
  CHATTICUS_CLOUD_ENVIRONMENTS,
  DEDICATED_ACCOUNT_HOSTNAMES,
  THIN_TURN_STACK_IDS,
  WEB_STACK_IDS,
  type ChatticusCloudEnvironment,
} from "./environments";
import { SnapshotStack } from "./snapshot-stack";
import { ThinTurnStack } from "./thin-turn-stack";
import { WebStack } from "./web-stack";

export const ENVIRONMENT_ZONES_STACK_ID = "ChatticusEnvironmentZones";
export const ENVIRONMENT_CERTIFICATES_STACK_ID = "ChatticusEnvironmentCertificates";

export interface DedicatedAccountProps {
  env: cdk.Environment;
  environmentName: ChatticusCloudEnvironment;
  budgetsConfig?: BudgetsConfig;
  installationName?: string;
  websiteDeploySource?: s3deploy.ISource;
}

export function readDedicatedEnvironment(app: cdk.App): ChatticusCloudEnvironment | undefined {
  const raw = app.node.tryGetContext("chatticusAccountEnvironment");
  if (raw === undefined || raw === "") {
    return undefined;
  }
  if (!CHATTICUS_CLOUD_ENVIRONMENTS.includes(raw as ChatticusCloudEnvironment)) {
    throw new Error(
      `Unknown chatticusAccountEnvironment '${raw}'. Expected one of: ${CHATTICUS_CLOUD_ENVIRONMENTS.join(", ")}`,
    );
  }
  return raw as ChatticusCloudEnvironment;
}

/**
 * The stacks of ONE environment in its own dedicated account: that environment's
 * thin-turn, web and auth stacks, its own copies of the shared stacks, and its
 * own delegated zones and certificates. The legacy three-environment account is
 * built by the default path in bin/chatticus.ts and is unchanged.
 */
export function buildDedicatedAccountStacks(app: cdk.App, props: DedicatedAccountProps): void {
  const { env, environmentName, budgetsConfig, installationName } = props;
  const hostnames = DEDICATED_ACCOUNT_HOSTNAMES[environmentName];

  const budgetsStack = budgetsConfig
    ? new BudgetsStack(app, "ChatticusBudgets", {
        env,
        monthlyLimitUsd: budgetsConfig.monthlyLimitUsd,
        notificationEmails: budgetsConfig.notificationEmails,
        description: "Account-level AWS spend budget and alerts.",
      })
    : undefined;
  const budgetsAlertsTopicArn = budgetsStack?.alertsTopic.topicArn;

  const snapshots = new SnapshotStack(app, "ChatticusSnapshots", {
    env,
    description: "Canonical S3 store for Chatticus computer snapshots.",
  });
  new ComputerStack(app, "ChatticusComputers", {
    env,
    description: "ECS cluster, ECR, and Fargate task definition for computer hosts.",
    snapshotBucket: snapshots.bucket,
  });

  const zones = new EnvironmentZonesStack(app, ENVIRONMENT_ZONES_STACK_ID, {
    env,
    siteDomain: hostnames.siteDomain,
    authDomain: hostnames.authDomain,
    description: `Delegated Route 53 zones for the ${environmentName} environment's names.`,
  });
  const certificates = new EnvironmentCertificatesStack(app, ENVIRONMENT_CERTIFICATES_STACK_ID, {
    env,
    siteDomain: hostnames.siteDomain,
    authDomain: hostnames.authDomain,
    siteZone: zones.siteZone,
    authZone: zones.authZone,
    description: `ACM certificates for the ${environmentName} environment's names.`,
  });

  const thinTurn = new ThinTurnStack(app, THIN_TURN_STACK_IDS[environmentName], {
    env,
    chatticusEnvironment: environmentName,
    budgetsAlertsTopicArn,
    budgetsMonthlyLimitUsd: budgetsConfig?.monthlyLimitUsd,
    installationName,
    description:
      `Zero-idle computerless turn (${environmentName}): DynamoDB, SQS, ` +
      "Lambda SSE front door.",
  });

  const web = new WebStack(app, WEB_STACK_IDS[environmentName], {
    env,
    chatticusEnvironment: environmentName,
    siteDomain: hostnames.siteDomain,
    hostedZone: zones.siteZone,
    siteCertificate: certificates.siteCertificate,
    frontDoorFunctionUrl: thinTurn.frontDoorFunctionUrl,
    invokeSecret: thinTurn.invokeSecret,
    websiteDeploySource: props.websiteDeploySource,
    description:
      `Next.js UI (${environmentName}) on CloudFront with same-origin /api/* ` +
      "proxy to the thin-turn function URL.",
  });
  web.addDependency(thinTurn);

  new AuthStack(app, AUTH_STACK_IDS[environmentName], {
    env,
    chatticusEnvironment: environmentName,
    siteDomain: hostnames.siteDomain,
    authDomainName: hostnames.authDomain,
    hostedZone: zones.authZone,
    siteCertificate: certificates.authCertificate,
    budgetsAlertsTopicArn,
    description:
      `Cognito user pool (${environmentName}) with Google federation and ` +
      "custom auth domain for SPA authorization code + PKCE.",
  });
}
