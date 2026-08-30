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

export function thinTurnParameterPrefix(environment: ChatticusCloudEnvironment): string {
  return `/chatticus/${environment}/thin-turn`;
}
