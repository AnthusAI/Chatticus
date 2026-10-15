export const CHATTICUS_CLOUD_ENVIRONMENTS = [
  "development",
  "staging",
  "production",
] as const;

export type ChatticusCloudEnvironment = (typeof CHATTICUS_CLOUD_ENVIRONMENTS)[number];

export const THIN_TURN_STACK_IDS: Record<ChatticusCloudEnvironment, string> = {
  development: "ChatticusThinTurn",
  staging: "ChatticusThinTurnStaging",
  production: "ChatticusThinTurnProduction",
};

export const CONTROL_PLANE_STACK_IDS: Record<ChatticusCloudEnvironment, string> = {
  development: "ChatticusControlPlane",
  staging: "ChatticusControlPlaneStaging",
  production: "ChatticusControlPlaneProduction",
};

export const WEB_STACK_IDS: Record<ChatticusCloudEnvironment, string> = {
  development: "ChatticusWeb",
  staging: "ChatticusWebStaging",
  production: "ChatticusWebProduction",
};

export const AUTH_STACK_IDS: Record<ChatticusCloudEnvironment, string> = {
  development: "ChatticusAuth",
  staging: "ChatticusAuthStaging",
  production: "ChatticusAuthProduction",
};

/**
 * Stack ids of the stacks that were once one copy per account. Development keeps
 * the unsuffixed id it has always had; staging and production, which share one
 * AWS account, each get their own suffixed copy so the two never collide.
 */
export const SNAPSHOT_STACK_IDS: Record<ChatticusCloudEnvironment, string> = {
  development: "ChatticusSnapshots",
  staging: "ChatticusSnapshotsStaging",
  production: "ChatticusSnapshotsProduction",
};

export const COMPUTERS_STACK_IDS: Record<ChatticusCloudEnvironment, string> = {
  development: "ChatticusComputers",
  staging: "ChatticusComputersStaging",
  production: "ChatticusComputersProduction",
};

export const ENVIRONMENT_ZONES_STACK_IDS: Record<ChatticusCloudEnvironment, string> = {
  development: "ChatticusEnvironmentZones",
  staging: "ChatticusEnvironmentZonesStaging",
  production: "ChatticusEnvironmentZonesProduction",
};

export const ENVIRONMENT_CERTIFICATES_STACK_IDS: Record<ChatticusCloudEnvironment, string> = {
  development: "ChatticusEnvironmentCertificates",
  staging: "ChatticusEnvironmentCertificatesStaging",
  production: "ChatticusEnvironmentCertificatesProduction",
};

export const ACCOUNT_DEPLOY_STACK_IDS: Record<ChatticusCloudEnvironment, string> = {
  development: "ChatticusAccountDeploy",
  staging: "ChatticusAccountDeployStaging",
  production: "ChatticusAccountDeployProduction",
};

/**
 * The GitHub OIDC identity provider exists once per AWS account. Development's
 * account creates it inside ChatticusAccountDeploy; the account that holds
 * staging and production creates it once in this stack, and both environments'
 * deploy stacks import it.
 */
export const GITHUB_OIDC_PROVIDER_STACK_ID = "ChatticusGitHubOidcProvider";

export const ACCOUNT_DEPLOY_ROLE_NAMES: Record<ChatticusCloudEnvironment, string> = {
  development: "chatticus-github-actions-deploy",
  staging: "chatticus-github-actions-deploy-staging",
  production: "chatticus-github-actions-deploy-production",
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
 * The environments whose stacks live in the same AWS account as the given one.
 * Staging and production share the production account; development has an
 * account of its own.
 */
export function peerEnvironmentsInSameAccount(
  environment: ChatticusCloudEnvironment,
): ChatticusCloudEnvironment[] {
  if (environment === "development") {
    return [];
  }
  return environment === "staging" ? ["production"] : ["staging"];
}

export const AUTH_DOMAIN_NAMES: Record<ChatticusCloudEnvironment, string> = {
  development: "auth-dev.chattic.us",
  staging: "auth-staging.chattic.us",
  production: "auth.chattic.us",
};

export const WEB_SITE_DOMAINS: Record<ChatticusCloudEnvironment, string> = {
  development: "dev.chattic.us",
  staging: "staging.chattic.us",
  production: "hey.chattic.us",
};

export interface EnvironmentHostnames {
  siteDomain: string;
  authDomain: string;
}

/**
 * Hostnames of an environment that runs in its own dedicated account. CloudFront
 * alternate domain names and Cognito custom domains are unique worldwide, so an
 * environment moving out of the legacy account cannot reuse a name the legacy
 * environment still holds: development takes new names and legacy's dev names
 * are retired with it. Staging and production keep their names and can only be
 * deployed once legacy has released them.
 */
export const DEDICATED_ACCOUNT_HOSTNAMES: Record<ChatticusCloudEnvironment, EnvironmentHostnames> = {
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
  return [
    THIN_TURN_STACK_IDS,
    CONTROL_PLANE_STACK_IDS,
    WEB_STACK_IDS,
    AUTH_STACK_IDS,
    SNAPSHOT_STACK_IDS,
    COMPUTERS_STACK_IDS,
    ENVIRONMENT_ZONES_STACK_IDS,
    ENVIRONMENT_CERTIFICATES_STACK_IDS,
    ACCOUNT_DEPLOY_STACK_IDS,
  ].map((ids) => ids[environment]);
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

export function operatorKeySecretArnParameterName(
  environment: ChatticusCloudEnvironment,
): string {
  return `${thinTurnParameterPrefix(environment)}/operator-key-secret-arn`;
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

/** Anthus deployments allow product signup; customer deployments use invitation_only. */
export function signupModeForEnvironment(
  _environment: ChatticusCloudEnvironment,
): "open" | "invitation_only" {
  return "open";
}
