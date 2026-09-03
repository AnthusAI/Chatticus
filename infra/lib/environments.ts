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

/** Production marketing apex; dev/staging use a single app domain (no split). */
export const WEB_MARKETING_DOMAINS: Partial<
  Record<ChatticusCloudEnvironment, string>
> = {
  production: "chattic.us",
};

/** CloudFront ``enabled`` on ChatticusWeb* stacks (disable staging/prod without destroy). */
export const WEB_CLOUDFRONT_ENABLED: Record<ChatticusCloudEnvironment, boolean> = {
  development: true,
  staging: true,
  production: true,
};

export function thinTurnParameterPrefix(environment: ChatticusCloudEnvironment): string {
  return `/chatticus/${environment}/thin-turn`;
}

export function openAiApiKeyParameterName(
  environment: ChatticusCloudEnvironment,
): string {
  return `${thinTurnParameterPrefix(environment)}/openai-api-key`;
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
