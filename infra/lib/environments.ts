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

export const WEB_SITE_DOMAINS: Record<ChatticusCloudEnvironment, string> = {
  development: "dev.chattic.us",
  staging: "staging.chattic.us",
  production: "chattic.us",
};

export function thinTurnParameterPrefix(environment: ChatticusCloudEnvironment): string {
  return `/chatticus/${environment}/thin-turn`;
}

export function webParameterPrefix(environment: ChatticusCloudEnvironment): string {
  return `/chatticus/${environment}/web`;
}

export function thinTurnExportName(
  environment: ChatticusCloudEnvironment,
  suffix: string,
): string {
  return `Chatticus-${environment}-thin-turn-${suffix}`;
}
