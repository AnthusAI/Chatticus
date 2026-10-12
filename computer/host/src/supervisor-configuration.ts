import { requiredPositiveIntegerSetting, requiredSetting } from "./owner-configuration.ts";

/** The name of the variable the starter puts the one-time bootstrap token in. */
export const BOOTSTRAP_TOKEN_VARIABLE = "CHATTICUS_OWNER_BOOTSTRAP_TOKEN";

/** What the supervisor needs from its task environment before it can bootstrap. */
export type SupervisorConfiguration = {
	readonly tenantId: string;
	readonly userId: string;
	readonly ownerId: string;
	readonly generation: number;
	readonly frontDoorUrl: string;
	readonly snapshotBucket: string;
	readonly liveRoot: string;
	readonly workspaceRoot: string;
	/** The one-time token. The environment it came from no longer holds it. */
	readonly bootstrapToken: string;
};

const CHILD_SETTINGS = [
	"CHATTICUS_MESSAGING_TABLE",
	"CHATTICUS_CONVERSATIONS_TABLE",
	"CHATTICUS_PI_SESSIONS_BUCKET",
	"CHATTICUS_ENVIRONMENT",
	"CHATTICUS_MODEL_GATEWAY_URL",
] as const;

/**
 * Read the supervisor's configuration from its task environment and remove the bootstrap token from that environment, so
 * the only copy is the one returned. The settings the per-turn children share are checked here too, so a task that could
 * never serve a turn stops at once instead of failing three children.
 *
 * @param environment The task environment; the bootstrap token is deleted from it.
 * @returns The typed configuration.
 * @throws OwnerConfigurationError If a required variable is missing or the generation is not a positive integer. The message names the variable and never a value.
 */
export function supervisorConfigurationFromEnvironment(environment: NodeJS.ProcessEnv): SupervisorConfiguration {
	const bootstrapToken = requiredSetting(environment, BOOTSTRAP_TOKEN_VARIABLE);
	delete environment[BOOTSTRAP_TOKEN_VARIABLE];
	const generation = requiredPositiveIntegerSetting(environment, "CHATTICUS_OWNER_START_GENERATION");
	for (const name of CHILD_SETTINGS) requiredSetting(environment, name);
	return {
		tenantId: requiredSetting(environment, "CHATTICUS_TENANT_ID"),
		userId: requiredSetting(environment, "CHATTICUS_USER_ID"),
		ownerId: requiredSetting(environment, "CHATTICUS_OWNER_ID"),
		generation,
		frontDoorUrl: requiredSetting(environment, "CHATTICUS_FRONT_DOOR_URL").replace(/\/+$/, ""),
		snapshotBucket: requiredSetting(environment, "CHATTICUS_SNAPSHOT_BUCKET"),
		liveRoot: (environment["CHATTICUS_LIVE_ROOT"] ?? "").trim().replace(/\/+$/, "") || "/var/lib/chatticus/computer",
		workspaceRoot: (environment["CHATTICUS_WORKSPACE_ROOT"] ?? "").trim() || "/workspace",
		bootstrapToken,
	};
}
