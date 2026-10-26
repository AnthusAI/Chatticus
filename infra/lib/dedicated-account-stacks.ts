import * as cdk from "aws-cdk-lib";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { AuditTrailStack } from "./audit-trail-stack";
import { AuthStack } from "./auth-stack";
import { BudgetsStack } from "./budgets-stack";
import type { BudgetsConfig } from "./budgets-config";
import { ComputerStack } from "./computer-stack";
import { EnvironmentCertificatesStack } from "./environment-certificates-stack";
import { MailIngressStack } from "./mail-ingress-stack";
import { MailStack } from "./mail-stack";
import { EnvironmentZonesStack } from "./environment-zones-stack";
import {
  AUTH_STACK_IDS,
  CHATTICUS_CLOUD_ENVIRONMENTS,
  COMPUTERS_STACK_IDS,
  CONTROL_PLANE_STACK_IDS,
  ENVIRONMENT_HOSTNAMES,
  ENVIRONMENT_CERTIFICATES_STACK_IDS,
  ENVIRONMENT_ZONES_STACK_IDS,
  MAIL_DELEGATED_FROM_SITE_ZONE,
  MAIL_DOMAINS,
  MAIL_INGRESS_STACK_ID,
  MAIL_STACK_IDS,
  mailEnabled,
  SNAPSHOT_STACK_IDS,
  THIN_TURN_STACK_IDS,
  WEB_STACK_IDS,
  type ChatticusCloudEnvironment,
} from "./environments";
import { SnapshotStack } from "./snapshot-stack";
import { ControlPlaneStack } from "./control-plane-stack";
import { ThinTurnStack } from "./thin-turn-stack";
import { WebStack } from "./web-stack";

export interface DedicatedAccountProps {
  env: cdk.Environment;
  environmentName: ChatticusCloudEnvironment;
  budgetsConfig?: BudgetsConfig;
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
 * The stacks of ONE environment: that environment's thin-turn, control-plane, web
 * and auth stacks, its own snapshots, computers, delegated zones and
 * certificates. Every one of them has an id that names the environment
 * (production keeps the unsuffixed ids it was deployed under), so development,
 * staging and production can all be deployed into the one account that holds
 * them without a stack, repository, task definition family or role colliding.
 * The budget stack is account-level: its id is the same for every environment,
 * so the account has exactly one copy of it, owned by production. The audit
 * trail stack is account-level the same way, but only the production build
 * creates it, so development and staging never synthesize a second copy. The legacy
 * three-environment account is built by the default path in bin/chatticus.ts.
 */
export function buildDedicatedAccountStacks(app: cdk.App, props: DedicatedAccountProps): void {
  const { env, environmentName, budgetsConfig } = props;
  const hostnames = ENVIRONMENT_HOSTNAMES[environmentName];

  const budgetsStack = budgetsConfig
    ? new BudgetsStack(app, "ChatticusBudgets", {
        env,
        monthlyLimitUsd: budgetsConfig.monthlyLimitUsd,
        notificationEmails: budgetsConfig.notificationEmails,
        description: "Account-level AWS spend budget and alerts.",
      })
    : undefined;
  const budgetsAlertsTopicArn = budgetsStack?.alertsTopic.topicArn;

  if (environmentName === "production") {
    new AuditTrailStack(app, "ChatticusAuditTrail", {
      env,
      description: "Account-level management-event audit trail (CloudTrail to S3), owned by production.",
    });
  }

  const snapshots = new SnapshotStack(app, SNAPSHOT_STACK_IDS[environmentName], {
    env,
    description: "Canonical S3 store for Chatticus computer snapshots.",
  });
  new ComputerStack(app, COMPUTERS_STACK_IDS[environmentName], {
    env,
    chatticusEnvironment: environmentName,
    description: "ECS cluster, ECR, and Fargate task definition for computer hosts.",
    snapshotBucket: snapshots.bucket,
  });

  const zones = new EnvironmentZonesStack(app, ENVIRONMENT_ZONES_STACK_IDS[environmentName], {
    env,
    siteDomain: hostnames.siteDomain,
    authDomain: hostnames.authDomain,
    description: `Delegated Route 53 zones for the ${environmentName} environment's names.`,
  });
  const certificates = new EnvironmentCertificatesStack(app, ENVIRONMENT_CERTIFICATES_STACK_IDS[environmentName], {
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
    description:
      `Permanent data stack (${environmentName}): Messaging table, secrets and budget jobs.`,
  });

  const controlPlane = new ControlPlaneStack(app, CONTROL_PLANE_STACK_IDS[environmentName], {
    env,
    chatticusEnvironment: environmentName,
    messagingTable: thinTurn.messagingTable,
    description:
      `TypeScript conversation control plane (${environmentName}), fronts /api/* through the web stack.`,
  });

  const web = new WebStack(app, WEB_STACK_IDS[environmentName], {
    env,
    chatticusEnvironment: environmentName,
    siteDomain: hostnames.siteDomain,
    hostedZone: zones.siteZone,
    siteCertificate: certificates.siteCertificate,
    frontDoorFunctionUrl: controlPlane.frontDoorFunctionUrl,
    invokeSecret: thinTurn.invokeSecret,
    websiteDeploySource: props.websiteDeploySource,
    description:
      `Next.js UI (${environmentName}) on CloudFront with same-origin /api/* ` +
      "proxy to the control-plane function URL.",
  });
  web.addDependency(thinTurn);
  web.addDependency(controlPlane);

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

  if (mailEnabled(environmentName)) {
    const mailIngress = new MailIngressStack(app, MAIL_INGRESS_STACK_ID, {
      env,
      description: "Account-wide SES receipt rule set and its activation, shared by every environment's mail.",
    });
    const mail = new MailStack(app, MAIL_STACK_IDS[environmentName], {
      env,
      chatticusEnvironment: environmentName,
      mailDomain: MAIL_DOMAINS[environmentName],
      receiptRuleSet: mailIngress.ruleSet,
      delegationParentZone: MAIL_DELEGATED_FROM_SITE_ZONE[environmentName] ? zones.siteZone : undefined,
      description: `Mail zone, SES identity, receipt rule, raw mail bucket and outbound configuration set (${environmentName}).`,
    });
    mail.addDependency(mailIngress);
  }
}
