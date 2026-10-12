import { describe, expect, it } from "vitest";
import { OwnerConfigurationError } from "../../computer/host/src/owner-configuration.ts";
import { ownerIdentityFromEnvironment, ownerStoresConfigFromEnvironment, ownerTurnJobFromEnvironment } from "../../computer/host/src/owner-deps.ts";
import { createGatewayModels } from "../../computer/host/src/owner-models.ts";
import { CHILD_EXIT_CONFIGURATION, CHILD_EXIT_SHELL_ISOLATION, CHILD_EXIT_UNCAUGHT, ShellIsolationError, ownerChildExitCodeForError, ownerExitCodeFor } from "../../computer/host/src/owner.ts";

const gateway = { baseUrl: "https://gateway.example.test/v1", token: "session-token-1" };

describe("createGatewayModels", () => {
	it("points every model at the gateway and authenticates with the injected token", async () => {
		const models = createGatewayModels(gateway);
		const model = models.getModel("openai", "gpt-5-nano");
		expect(model?.baseUrl).toBe(gateway.baseUrl);
		const auth = await models.getAuth("openai");
		expect(auth?.auth).toEqual({ apiKey: gateway.token });
	});

	it("does not read the vendor key from the environment", async () => {
		const saved = process.env["OPENAI_API_KEY"];
		process.env["OPENAI_API_KEY"] = "vendor-key-must-not-be-used";
		try {
			const auth = await createGatewayModels(gateway).getAuth("openai");
			expect(JSON.stringify(auth)).not.toContain("vendor-key-must-not-be-used");
		} finally {
			if (saved === undefined) delete process.env["OPENAI_API_KEY"];
			else process.env["OPENAI_API_KEY"] = saved;
		}
	});
});

describe("ownerStoresConfigFromEnvironment", () => {
	const complete = {
		CHATTICUS_MESSAGING_TABLE: "messaging",
		CHATTICUS_CONVERSATIONS_TABLE: "conversations",
		CHATTICUS_PI_SESSIONS_BUCKET: "sessions",
		CHATTICUS_ENVIRONMENT: "development",
		CHATTICUS_MODEL_GATEWAY_URL: gateway.baseUrl,
		CHATTICUS_MODEL_GATEWAY_TOKEN: gateway.token,
	};

	it("reads the stores and the gateway", () => {
		expect(ownerStoresConfigFromEnvironment(complete)).toEqual({
			messagingTableName: "messaging",
			conversationsTableName: "conversations",
			piSessionsBucket: "sessions",
			environment: "development",
			gateway,
		});
	});

	it("names the missing variable", () => {
		const { CHATTICUS_MODEL_GATEWAY_TOKEN: _omitted, ...incomplete } = complete;
		expect(() => ownerStoresConfigFromEnvironment(incomplete)).toThrow(OwnerConfigurationError);
		expect(() => ownerStoresConfigFromEnvironment(incomplete)).toThrow("CHATTICUS_MODEL_GATEWAY_TOKEN");
	});
});

describe("ownerTurnJobFromEnvironment", () => {
	const complete = {
		CHATTICUS_TENANT_ID: "t",
		CHATTICUS_TAKEOVER_TURN_ID: "u",
		CHATTICUS_TAKEOVER_BOT_ID: "b",
		CHATTICUS_DISPATCH_ID: "d",
	};

	it("reads the dispatched turn and the dispatch that delivered it", () => {
		expect(ownerTurnJobFromEnvironment(complete)).toEqual({ job: { tenantId: "t", turnId: "u", botId: "b" }, dispatchId: "d" });
	});

	it("names the missing variable", () => {
		const { CHATTICUS_TAKEOVER_TURN_ID: _omitted, ...incomplete } = complete;
		expect(() => ownerTurnJobFromEnvironment(incomplete)).toThrow("CHATTICUS_TAKEOVER_TURN_ID");
	});
});

describe("ownerIdentityFromEnvironment", () => {
	const complete = {
		CHATTICUS_TENANT_ID: "anthus",
		CHATTICUS_USER_ID: "ryan",
		CHATTICUS_OWNER_ID: "owner-1",
		CHATTICUS_OWNER_START_GENERATION: "3",
	};

	it("reads the identity and holds no Front Door address and no host token", () => {
		expect(ownerIdentityFromEnvironment(complete)).toEqual({ tenantId: "anthus", userId: "ryan", ownerId: "owner-1", generation: 3 });
	});

	it("names the missing variable", () => {
		const { CHATTICUS_OWNER_ID: _omitted, ...incomplete } = complete;
		expect(() => ownerIdentityFromEnvironment(incomplete)).toThrow("CHATTICUS_OWNER_ID");
	});

	it.each(["0", "-1", "two", "1.5"])("refuses the generation %s", (generation) => {
		expect(() => ownerIdentityFromEnvironment({ ...complete, CHATTICUS_OWNER_START_GENERATION: generation })).toThrow(OwnerConfigurationError);
	});
});

describe("ownerChildExitCodeForError", () => {
	it("maps wrong settings to 2, an unusable shell launcher to 3 and anything else to 70", () => {
		expect(ownerChildExitCodeForError(new OwnerConfigurationError("x"))).toBe(CHILD_EXIT_CONFIGURATION);
		expect(ownerChildExitCodeForError(new ShellIsolationError("x"))).toBe(CHILD_EXIT_SHELL_ISOLATION);
		expect(ownerChildExitCodeForError(new Error("x"))).toBe(CHILD_EXIT_UNCAUGHT);
		expect([CHILD_EXIT_CONFIGURATION, CHILD_EXIT_SHELL_ISOLATION, CHILD_EXIT_UNCAUGHT]).toEqual([2, 3, 70]);
	});
});

describe("ownerExitCodeFor", () => {
	it.each(["done", "failed", "parked", "yielded", "already_finished"] as const)("exits 0 when the turn ended %s", (outcome) => {
		expect(ownerExitCodeFor(outcome)).toBe(0);
	});

	it.each(["lost", "reconciling", "not_found"] as const)("exits 1 when the turn ended %s", (outcome) => {
		expect(ownerExitCodeFor(outcome)).toBe(1);
	});
});
