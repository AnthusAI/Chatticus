import * as cdk from "aws-cdk-lib";
import {
  AUTH_STACK_IDS,
  CHATTICUS_CLOUD_ENVIRONMENTS,
  THIN_TURN_STACK_IDS,
  WEB_STACK_IDS,
  type ChatticusCloudEnvironment,
} from "./environments";

export const TAG_APPLICATION = "chatticus:application";
export const TAG_ENVIRONMENT = "chatticus:environment";
export const TAG_INSTALLATION = "chatticus:installation";
export const TAG_COMPONENT = "chatticus:component";
export const TAG_TENANT = "chatticus:tenant";

export const APPLICATION_NAME = "Chatticus";
export const SHARED_ENVIRONMENT = "shared";

export interface StackTags {
  component: string;
  environment: ChatticusCloudEnvironment | typeof SHARED_ENVIRONMENT;
}

const SHARED_STACKS: Record<string, string> = {
  ChatticusBudgets: "budgets",
  ChatticusSnapshots: "snapshots",
  ChatticusComputers: "computer",
  ChatticusDns: "dns",
  ChatticusGitHubDeploy: "deploy",
  ChatticusIntegrationTest: "integration-test",
};

const ENVIRONMENT_STACKS: Array<[Record<ChatticusCloudEnvironment, string>, string]> = [
  [THIN_TURN_STACK_IDS, "thin-turn"],
  [WEB_STACK_IDS, "web"],
  [AUTH_STACK_IDS, "auth"],
];

/** Component and environment for one stack id; throws for a stack nobody classified. */
export function stackTagsFor(stackId: string): StackTags {
  const shared = SHARED_STACKS[stackId];
  if (shared !== undefined) return { component: shared, environment: SHARED_ENVIRONMENT };
  for (const [ids, component] of ENVIRONMENT_STACKS) {
    for (const environment of CHATTICUS_CLOUD_ENVIRONMENTS) {
      if (ids[environment] === stackId) return { component, environment };
    }
  }
  throw new Error(
    `Stack '${stackId}' has no entry in lib/tagging.ts. Add it so its spend can be attributed.`,
  );
}

const TAG_VALUE = /^[\p{L}\p{Z}\p{N}_.:/=+\-@]{1,256}$/u;

/** Installation name from the environment, or undefined when unset. Rejects values AWS cannot tag with. */
export function readInstallationName(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const raw = env.CHATTICUS_INSTALLATION_NAME?.trim();
  if (!raw) return undefined;
  if (!TAG_VALUE.test(raw)) {
    throw new Error(
      `CHATTICUS_INSTALLATION_NAME '${raw}' is not a valid AWS tag value ` +
        "(1-256 letters, digits, spaces and _ . : / = + - @).",
    );
  }
  return raw;
}

/** Tag one stack (and everything taggable in it) with the standard Chatticus cost tags. */
export function applyStandardTags(stack: cdk.Stack, installation: string | undefined): void {
  const { component, environment } = stackTagsFor(stack.node.id);
  const tags = cdk.Tags.of(stack);
  tags.add(TAG_APPLICATION, APPLICATION_NAME);
  tags.add(TAG_COMPONENT, component);
  tags.add(TAG_ENVIRONMENT, environment);
  if (installation === undefined) {
    cdk.Annotations.of(stack).addWarningV2(
      "chatticus:no-installation-tag",
      "CHATTICUS_INSTALLATION_NAME is not set, so this stack is not tagged with an installation. " +
        "Deploying without it removes the tag from an already-tagged stack.",
    );
    return;
  }
  tags.add(TAG_INSTALLATION, installation);
}
