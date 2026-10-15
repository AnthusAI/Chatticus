import { OWNER_CHILD_ENVIRONMENT_NAMES, OWNER_CHILD_FORBIDDEN_ENVIRONMENT_NAMES } from "@chatticus/host-protocol/supervisor";
import { describe, expect, it } from "vitest";
import { buildOwnerChildEnvironment } from "../../computer/host/src/supervisor-child-environment.ts";

const dispatch = {
	dispatch_id: "dispatch-1",
	turn_id: "turn-1",
	bot_id: "bot-1",
	user_id: "member-from-dispatch",
	gateway_token: "gateway-token-of-the-dispatch",
	aws_credentials: {
		access_key_id: "ASIATURNKEY",
		secret_access_key: "turn-secret",
		session_token: "turn-session",
		expires_at: "2026-10-12T09:00:00.000Z",
	},
};

const supervisorEnvironment: NodeJS.ProcessEnv = {
	PATH: "/usr/local/bin:/usr/bin",
	HOME: "/root",
	CHATTICUS_TENANT_ID: "anthus",
	CHATTICUS_USER_ID: "member-of-the-start",
	CHATTICUS_OWNER_ID: "owner-1",
	CHATTICUS_OWNER_START_GENERATION: "4",
	CHATTICUS_MESSAGING_TABLE: "messaging",
	CHATTICUS_CONVERSATIONS_TABLE: "conversations",
	CHATTICUS_PI_SESSIONS_BUCKET: "pi-sessions",
	CHATTICUS_ENVIRONMENT: "development",
	CHATTICUS_MODEL_GATEWAY_URL: "https://gateway.example.test/v1",
	CHATTICUS_WORKSPACE_ROOT: "/workspace",
	CHATTICUS_SHELL_LAUNCHER: "/usr/local/bin/chatticus-shell",
	AWS_REGION: "us-east-1",
	AWS_DEFAULT_REGION: "us-east-1",
	CHATTICUS_MODEL_GATEWAY_TOKEN: "gateway-token-of-the-supervisor",
	AWS_ACCESS_KEY_ID: "AKIASUPERVISOR",
	AWS_SECRET_ACCESS_KEY: "supervisor-secret",
	AWS_SESSION_TOKEN: "supervisor-session",
	CHATTICUS_OWNER_BOOTSTRAP_TOKEN: "bootstrap-secret",
	CHATTICUS_SUPERVISOR_TOKEN: "supervisor-token-secret",
	CHATTICUS_FRONT_DOOR_URL: "https://front-door.example.test",
	CHATTICUS_SNAPSHOT_BUCKET: "snapshots",
	CHATTICUS_LIVE_ROOT: "/var/lib/chatticus/computer",
	CHATTICUS_INVOKE_KEY: "invoke-key-secret",
	CHATTICUS_OWNER_HOST_TOKEN: "old-host-token-secret",
	OPENAI_API_KEY: "model-key-secret",
	SOME_OTHER_VARIABLE: "unlisted",
};

describe("buildOwnerChildEnvironment", () => {
	const environment = buildOwnerChildEnvironment(supervisorEnvironment, dispatch);

	it("holds exactly the names of the child list and no other key", () => {
		expect(Object.keys(environment).sort()).toEqual([...OWNER_CHILD_ENVIRONMENT_NAMES].sort());
	});

	it("holds none of the names that belong to the supervisor alone", () => {
		for (const name of OWNER_CHILD_FORBIDDEN_ENVIRONMENT_NAMES) expect(environment, name).not.toHaveProperty(name);
	});

	it("holds none of the supervisor's secret values, wherever they sit in its environment", () => {
		const secrets = [
			"gateway-token-of-the-supervisor",
			"AKIASUPERVISOR",
			"supervisor-secret",
			"supervisor-session",
			"bootstrap-secret",
			"supervisor-token-secret",
			"https://front-door.example.test",
			"snapshots",
			"/var/lib/chatticus/computer",
			"invoke-key-secret",
			"old-host-token-secret",
			"model-key-secret",
			"unlisted",
			"member-of-the-start",
		];
		const values = Object.values(environment);
		for (const secret of secrets) expect(values, secret).not.toContain(secret);
	});

	it("takes the member, the turn and the bot from the dispatch", () => {
		expect(environment).toMatchObject({
			CHATTICUS_USER_ID: "member-from-dispatch",
			CHATTICUS_DISPATCH_ID: "dispatch-1",
			CHATTICUS_TAKEOVER_TURN_ID: "turn-1",
			CHATTICUS_TAKEOVER_BOT_ID: "bot-1",
		});
	});

	it("holds no credential of the dispatch and names the supervisor's socket instead", () => {
		expect(environment).toMatchObject({ CHATTICUS_SUPERVISOR_SOCKET: "/run/chatticus/supervisor.sock" });
		for (const name of ["CHATTICUS_MODEL_GATEWAY_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) {
			expect(environment, name).not.toHaveProperty(name);
		}
		const values = Object.values(environment);
		for (const secret of ["gateway-token-of-the-dispatch", "ASIATURNKEY", "turn-secret", "turn-session"]) {
			expect(values, secret).not.toContain(secret);
		}
	});

	it("takes the shared settings from the supervisor", () => {
		expect(environment).toMatchObject({
			PATH: "/usr/local/bin:/usr/bin",
			HOME: "/root",
			CHATTICUS_TENANT_ID: "anthus",
			CHATTICUS_OWNER_ID: "owner-1",
			CHATTICUS_OWNER_START_GENERATION: "4",
			CHATTICUS_MESSAGING_TABLE: "messaging",
			CHATTICUS_MODEL_GATEWAY_URL: "https://gateway.example.test/v1",
			AWS_REGION: "us-east-1",
		});
	});

	it("leaves out a shared setting the supervisor does not have", () => {
		const { CHATTICUS_SHELL_LAUNCHER: _launcher, CHATTICUS_WORKSPACE_ROOT: _root, ...without } = supervisorEnvironment;
		const sparse = buildOwnerChildEnvironment(without, dispatch);
		expect(sparse).not.toHaveProperty("CHATTICUS_SHELL_LAUNCHER");
		expect(sparse).not.toHaveProperty("CHATTICUS_WORKSPACE_ROOT");
		expect(Object.keys(sparse).every((name) => (OWNER_CHILD_ENVIRONMENT_NAMES as readonly string[]).includes(name))).toBe(true);
	});

	it("returns a new object and does not touch the supervisor's environment", () => {
		const before = JSON.stringify(supervisorEnvironment);
		const built = buildOwnerChildEnvironment(supervisorEnvironment, dispatch);
		expect(built).not.toBe(supervisorEnvironment);
		expect(JSON.stringify(supervisorEnvironment)).toBe(before);
	});
});
