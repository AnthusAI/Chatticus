import { describe, expect, it } from "vitest";
import { OwnerConfigurationError } from "../../computer/host/src/owner-configuration.ts";
import { BOOTSTRAP_TOKEN_VARIABLE, supervisorConfigurationFromEnvironment } from "../../computer/host/src/supervisor-configuration.ts";

const complete = (): NodeJS.ProcessEnv => ({
	CHATTICUS_TENANT_ID: "anthus",
	CHATTICUS_USER_ID: "ryan",
	CHATTICUS_OWNER_ID: "owner-1",
	CHATTICUS_OWNER_START_GENERATION: "3",
	CHATTICUS_OWNER_BOOTSTRAP_TOKEN: "bootstrap-secret",
	CHATTICUS_FRONT_DOOR_URL: "https://front-door.test/",
	CHATTICUS_SNAPSHOT_BUCKET: "snapshots",
	CHATTICUS_MESSAGING_TABLE: "messaging",
	CHATTICUS_CONVERSATIONS_TABLE: "conversations",
	CHATTICUS_PI_SESSIONS_BUCKET: "pi-sessions",
	CHATTICUS_ENVIRONMENT: "development",
	CHATTICUS_MODEL_GATEWAY_URL: "https://gateway.test/v1",
});

describe("supervisorConfigurationFromEnvironment", () => {
	it("reads the configuration, trims the trailing slash of the Front Door and defaults the disk locations", () => {
		expect(supervisorConfigurationFromEnvironment(complete())).toEqual({
			tenantId: "anthus",
			userId: "ryan",
			ownerId: "owner-1",
			generation: 3,
			frontDoorUrl: "https://front-door.test",
			snapshotBucket: "snapshots",
			liveRoot: "/var/lib/chatticus/computer",
			workspaceRoot: "/workspace",
			bootstrapToken: "bootstrap-secret",
		});
	});

	it("honours the live root and the workspace root the task sets", () => {
		const environment = { ...complete(), CHATTICUS_LIVE_ROOT: "/data/computer/", CHATTICUS_WORKSPACE_ROOT: "/data/workspace" };
		expect(supervisorConfigurationFromEnvironment(environment)).toMatchObject({ liveRoot: "/data/computer", workspaceRoot: "/data/workspace" });
	});

	it("removes the bootstrap token from the environment it read", () => {
		const environment = complete();
		const configuration = supervisorConfigurationFromEnvironment(environment);
		expect(configuration.bootstrapToken).toBe("bootstrap-secret");
		expect(environment).not.toHaveProperty(BOOTSTRAP_TOKEN_VARIABLE);
		expect(Object.values(environment)).not.toContain("bootstrap-secret");
	});

	it.each([
		"CHATTICUS_TENANT_ID",
		"CHATTICUS_USER_ID",
		"CHATTICUS_OWNER_ID",
		"CHATTICUS_OWNER_START_GENERATION",
		"CHATTICUS_OWNER_BOOTSTRAP_TOKEN",
		"CHATTICUS_FRONT_DOOR_URL",
		"CHATTICUS_SNAPSHOT_BUCKET",
		"CHATTICUS_MESSAGING_TABLE",
		"CHATTICUS_CONVERSATIONS_TABLE",
		"CHATTICUS_PI_SESSIONS_BUCKET",
		"CHATTICUS_ENVIRONMENT",
		"CHATTICUS_MODEL_GATEWAY_URL",
	])("names the missing variable %s and nothing else", (name) => {
		const environment = complete();
		delete environment[name];
		expect(() => supervisorConfigurationFromEnvironment(environment)).toThrow(new OwnerConfigurationError(`The environment variable ${name} is required.`));
	});

	it.each(["0", "-2", "one", "1.5", " "])("refuses the generation %j", (generation) => {
		const environment = { ...complete(), CHATTICUS_OWNER_START_GENERATION: generation };
		expect(() => supervisorConfigurationFromEnvironment(environment)).toThrow(OwnerConfigurationError);
	});

	it("never puts the bootstrap token in a refusal", () => {
		const environment = complete();
		delete environment["CHATTICUS_TENANT_ID"];
		try {
			supervisorConfigurationFromEnvironment(environment);
			throw new Error("expected a refusal");
		} catch (error) {
			expect(String((error as Error).message)).not.toContain("bootstrap-secret");
		}
	});
});
