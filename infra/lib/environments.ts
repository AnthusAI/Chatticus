export const CHATTICUS_CLOUD_ENVIRONMENTS = [
  "development",
  "staging",
  "production",
] as const;

export type ChatticusCloudEnvironment = (typeof CHATTICUS_CLOUD_ENVIRONMENTS)[number];

/**
 * The environments whose control plane stack deploys the Kanbus board service (one KanbusApi per environment, with its
 * own bucket and table) and hands its URL to the Front Door and the turn executor. This is a documented rollout switch,
 * not a behavior fork: there is one code path, and extending the rollout to staging and then production is a one-line
 * change to this list. Development goes first by the owner's decision, see docs/BOT_BOARDS.md section 11.
 */
export const KANBUS_BOARD_ENVIRONMENTS: readonly ChatticusCloudEnvironment[] = ["development"];

/**
 * The environments whose mail stack (mail zone, SES identity, receipt rule, raw mail bucket and outbound configuration
 * set) is built. A documented rollout switch, not a behavior fork: extending mail to staging and then production is a
 * one-line change here plus the matching deploy workflow and deploy script entries. Development goes first by the
 * owner's decision, see docs/MAIL_INFRASTRUCTURE.md.
 */
export const MAIL_ENVIRONMENTS: readonly ChatticusCloudEnvironment[] = ["development"];

export const THIN_TURN_STACK_IDS: Record<ChatticusCloudEnvironment, string> = {
  development: "ChatticusThinTurnDevelopment",
  staging: "ChatticusThinTurnStaging",
  production: "ChatticusThinTurnProduction",
};

export const CONTROL_PLANE_STACK_IDS: Record<ChatticusCloudEnvironment, string> = {
  development: "ChatticusControlPlaneDevelopment",
  staging: "ChatticusControlPlaneStaging",
  production: "ChatticusControlPlaneProduction",
};

export const WEB_STACK_IDS: Record<ChatticusCloudEnvironment, string> = {
  development: "ChatticusWebDevelopment",
  staging: "ChatticusWebStaging",
  production: "ChatticusWebProduction",
};

export const AUTH_STACK_IDS: Record<ChatticusCloudEnvironment, string> = {
  development: "ChatticusAuthDevelopment",
  staging: "ChatticusAuthStaging",
  production: "ChatticusAuthProduction",
};

/**
 * Stack ids of the stacks that were once one copy per account. All three
 * environments live in the one production account, so every environment except
 * production carries an environment suffix. Production keeps the unsuffixed ids
 * it has always had: its account already holds those stacks, live, and renaming
 * one would replace its resources and change the name servers of its delegated
 * zones. Development and staging take the suffixed ids, so the three never
 * collide on a stack, repository, task definition family or role.
 */
export const SNAPSHOT_STACK_IDS: Record<ChatticusCloudEnvironment, string> = {
  development: "ChatticusSnapshotsDevelopment",
  staging: "ChatticusSnapshotsStaging",
  production: "ChatticusSnapshots",
};

export const COMPUTERS_STACK_IDS: Record<ChatticusCloudEnvironment, string> = {
  development: "ChatticusComputersDevelopment",
  staging: "ChatticusComputersStaging",
  production: "ChatticusComputers",
};

export const ENVIRONMENT_ZONES_STACK_IDS: Record<ChatticusCloudEnvironment, string> = {
  development: "ChatticusEnvironmentZonesDevelopment",
  staging: "ChatticusEnvironmentZonesStaging",
  production: "ChatticusEnvironmentZones",
};

export const ENVIRONMENT_CERTIFICATES_STACK_IDS: Record<ChatticusCloudEnvironment, string> = {
  development: "ChatticusEnvironmentCertificatesDevelopment",
  staging: "ChatticusEnvironmentCertificatesStaging",
  production: "ChatticusEnvironmentCertificates",
};

export const MAIL_STACK_IDS: Record<ChatticusCloudEnvironment, string> = {
  development: "ChatticusMailDevelopment",
  staging: "ChatticusMailStaging",
  production: "ChatticusMailProduction",
};

/**
 * The shared mail ingress stack. It owns the one active SES receipt rule set of the account and region, which all
 * three environments share, so it has a single unsuffixed id and is deployed first and by name.
 */
export const MAIL_INGRESS_STACK_ID = "ChatticusMailIngress";

/** The name of the account's single receipt rule set, owned by the shared mail ingress stack. */
export const MAIL_RECEIPT_RULE_SET_NAME = "chatticus-mail-ingress";

/** Days raw inbound mail stays in the raw mail bucket before the lifecycle rule expires it. */
export const MAIL_RAW_RETENTION_DAYS = 30;

/**
 * The domain each environment receives and sends bot mail on. Staging and development sit below their own site name
 * and are delegated from that environment's site zone inside the same account. Production uses mail.chattic.us, which
 * needs one NS record in the management account's chattic.us zone, added by the owner later (docs/MAIL_INFRASTRUCTURE.md).
 */
export const MAIL_DOMAINS: Record<ChatticusCloudEnvironment, string> = {
  development: "mail.develop.chattic.us",
  staging: "mail.staging.chattic.us",
  production: "mail.chattic.us",
};

/** Whether an environment's mail zone is delegated by an NS record in its own site zone, in the same account. */
export const MAIL_DELEGATED_FROM_SITE_ZONE: Record<ChatticusCloudEnvironment, boolean> = {
  development: true,
  staging: true,
  production: false,
};

/** Whether the mail stack of an environment is built. */
export function mailEnabled(environment: ChatticusCloudEnvironment): boolean {
  return MAIL_ENVIRONMENTS.includes(environment);
}

export const ACCOUNT_DEPLOY_STACK_IDS: Record<ChatticusCloudEnvironment, string> = {
  development: "ChatticusAccountDeployDevelopment",
  staging: "ChatticusAccountDeployStaging",
  production: "ChatticusAccountDeploy",
};

/**
 * Whether an environment's deploy stack creates the GitHub OIDC identity provider
 * of the account. AWS allows one provider per issuer URL per account, and all
 * three environments share one account. Production's ChatticusAccountDeploy has
 * always created it. Development's and staging's deploy stacks import that
 * provider by ARN and require production's deploy stack to exist first.
 */
export const ACCOUNT_DEPLOY_CREATES_OIDC_PROVIDER: Record<ChatticusCloudEnvironment, boolean> = {
  development: false,
  staging: false,
  production: true,
};

export const ACCOUNT_DEPLOY_ROLE_NAMES: Record<ChatticusCloudEnvironment, string> = {
  development: "chatticus-github-actions-deploy-development",
  staging: "chatticus-github-actions-deploy-staging",
  production: "chatticus-github-actions-deploy",
};

/**
 * The moving ECR tag each environment's owner task definition runs. Each
 * environment has its own repository (its own Computers stack), so the tag name
 * only has to identify the environment for a human reading a task definition.
 */
export const COMPUTER_IMAGE_TAGS: Record<ChatticusCloudEnvironment, string> = {
  development: "dev",
  staging: "staging",
  production: "production",
};

/**
 * The other environments whose stacks live in the same AWS account as the given
 * one. All three environments share the production account, so each has the
 * other two as peers.
 */
export function peerEnvironmentsInSameAccount(
  environment: ChatticusCloudEnvironment,
): ChatticusCloudEnvironment[] {
  return CHATTICUS_CLOUD_ENVIRONMENTS.filter((name) => name !== environment);
}

export interface EnvironmentHostnames {
  siteDomain: string;
  authDomain: string;
}

/**
 * The hostnames each environment is served from in the production account.
 * CloudFront alternate domain names and Cognito custom domains are unique
 * worldwide, so the names a retired account's environment still holds cannot be
 * reused until it releases them: development takes develop.chattic.us and
 * auth-develop.chattic.us, never the retired dev.chattic.us names.
 */
export const ENVIRONMENT_HOSTNAMES: Record<ChatticusCloudEnvironment, EnvironmentHostnames> = {
  development: { siteDomain: "develop.chattic.us", authDomain: "auth-develop.chattic.us" },
  staging: { siteDomain: "staging.chattic.us", authDomain: "auth-staging.chattic.us" },
  production: { siteDomain: "hey.chattic.us", authDomain: "auth.chattic.us" },
};

/** CloudFront ``enabled`` on ChatticusWeb* stacks (disable staging/prod without destroy). */
export const WEB_CLOUDFRONT_ENABLED: Record<ChatticusCloudEnvironment, boolean> = {
  development: true,
  staging: true,
  production: true,
};

/**
 * Whether the web UI is served cross-origin isolated (COOP same-origin, COEP
 * require-corp). On-device voice needs it for the threaded WASM build
 * (docs/VOICE.md). Development only until the isolation check against sign-in
 * passes (chatticus-604bb6).
 */
export const WEB_CROSS_ORIGIN_ISOLATION: Record<ChatticusCloudEnvironment, boolean> = {
  development: true,
  staging: false,
  production: false,
};

/** Every stack id that belongs to exactly one environment, shared-by-name stacks included. */
export function stackIdsOfEnvironment(environment: ChatticusCloudEnvironment): string[] {
  const mailStackIds = mailEnabled(environment) ? [MAIL_STACK_IDS[environment]] : [];
  return [...mailStackIds, ...[
    THIN_TURN_STACK_IDS,
    CONTROL_PLANE_STACK_IDS,
    WEB_STACK_IDS,
    AUTH_STACK_IDS,
    SNAPSHOT_STACK_IDS,
    COMPUTERS_STACK_IDS,
    ENVIRONMENT_ZONES_STACK_IDS,
    ENVIRONMENT_CERTIFICATES_STACK_IDS,
    ACCOUNT_DEPLOY_STACK_IDS,
  ].map((ids) => ids[environment])];
}

export function thinTurnParameterPrefix(environment: ChatticusCloudEnvironment): string {
  return `/chatticus/${environment}/thin-turn`;
}

export function openAiApiKeyParameterName(
  environment: ChatticusCloudEnvironment,
): string {
  return `${thinTurnParameterPrefix(environment)}/openai-api-key`;
}

export function invokeKeySecretArnParameterName(
  environment: ChatticusCloudEnvironment,
): string {
  return `${thinTurnParameterPrefix(environment)}/invoke-key-secret-arn`;
}

/** The SSM SecureString parameter that holds the generated operator key of one environment. */
export function operatorKeyParameterName(
  environment: ChatticusCloudEnvironment,
): string {
  return `${thinTurnParameterPrefix(environment)}/operator-key`;
}

/** The SSM SecureString parameter that holds the generated model gateway signing key of one environment. */
export function modelGatewaySigningKeyParameterName(
  environment: ChatticusCloudEnvironment,
): string {
  return `/chatticus/${environment}/model-gateway/signing-key`;
}

export function webParameterPrefix(environment: ChatticusCloudEnvironment): string {
  return `/chatticus/${environment}/web`;
}

export function integrationTestParameterPrefix(
  environment: ChatticusCloudEnvironment,
): string {
  return `/chatticus/${environment}/integration-test`;
}

export function thinTurnExportName(
  environment: ChatticusCloudEnvironment,
  suffix: string,
): string {
  return `Chatticus-${environment}-thin-turn-${suffix}`;
}

/**
 * Whether a signed-in person may create an organization. Open signup lets any
 * Google account create an organization that spends platform money, so only
 * development is open. Staging and production are invitation_only until the
 * owner opts in to public signup by changing this function and deploying.
 */
export function signupModeForEnvironment(
  environment: ChatticusCloudEnvironment,
): "open" | "invitation_only" {
  return environment === "development" ? "open" : "invitation_only";
}
