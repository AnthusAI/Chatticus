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
