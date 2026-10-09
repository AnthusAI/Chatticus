import { describe, expect, it } from "vitest";
import { OwnerConfigurationError, ownerIdentityFromEnvironment, ownerStoresConfigFromEnvironment } from "../../computer/host/src/owner-deps.ts";
import { createGatewayModels } from "../../computer/host/src/owner-models.ts";
import { ownerExitCodeFor, startJobSourceFromEnvironment } from "../../computer/host/src/owner.ts";
import { computerRuntimeFromEnvironment } from "../src/computer/host-starter.ts";

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
		CHATTICUS_INVOKE_KEY: "invoke-key-1",
	};

	it("reads the stores and the gateway", () => {
		expect(ownerStoresConfigFromEnvironment(complete)).toEqual({
			messagingTableName: "messaging",
			conversationsTableName: "conversations",
			piSessionsBucket: "sessions",
			environment: "development",
			gateway: { ...gateway, invokeKey: "invoke-key-1" },
		});
	});

	it("names the missing variable", () => {
		const { CHATTICUS_MODEL_GATEWAY_TOKEN: _omitted, ...incomplete } = complete;
		expect(() => ownerStoresConfigFromEnvironment(incomplete)).toThrow(OwnerConfigurationError);
		expect(() => ownerStoresConfigFromEnvironment(incomplete)).toThrow("CHATTICUS_MODEL_GATEWAY_TOKEN");
	});
});

describe("startJobSourceFromEnvironment", () => {
	it("yields the named turn once and then none", async () => {
		const source = startJobSourceFromEnvironment({ CHATTICUS_TENANT_ID: "t", CHATTICUS_TAKEOVER_TURN_ID: "u", CHATTICUS_TAKEOVER_BOT_ID: "b" });
		expect(await source.claim()).toEqual({ tenantId: "t", turnId: "u", botId: "b" });
		expect(await source.claim()).toBeNull();
	});

	it("yields none when the start named no turn", async () => {
		expect(await startJobSourceFromEnvironment({ CHATTICUS_TENANT_ID: "t" }).claim()).toBeNull();
	});
});

describe("ownerIdentityFromEnvironment", () => {
	const complete = {
		CHATTICUS_TENANT_ID: "anthus",
		CHATTICUS_USER_ID: "ryan",
		CHATTICUS_OWNER_ID: "owner-1",
		CHATTICUS_FRONT_DOOR_URL: "https://front-door.test/",
		CHATTICUS_INVOKE_KEY: "invoke-key-1",
	};

	it("reads the identity and trims the trailing slash of the Front Door", () => {
		expect(ownerIdentityFromEnvironment(complete)).toEqual({
			tenantId: "anthus",
			userId: "ryan",
			ownerId: "owner-1",
			frontDoorUrl: "https://front-door.test",
			invokeKey: "invoke-key-1",
		});
	});

	it("names the missing variable", () => {
		const { CHATTICUS_OWNER_ID: _omitted, ...incomplete } = complete;
		expect(() => ownerIdentityFromEnvironment(incomplete)).toThrow("CHATTICUS_OWNER_ID");
	});
});

describe("ownerExitCodeFor", () => {
	it.each(["done", "failed", "parked", "yielded", "already_finished"] as const)("exits 0 when the turn ended %s", (outcome) => {
		expect(ownerExitCodeFor(outcome)).toBe(0);
	});

	it.each(["lost", "reconciling", "not_found", "no_job"] as const)("exits 1 when the turn ended %s", (outcome) => {
		expect(ownerExitCodeFor(outcome)).toBe(1);
	});
});

describe("computerRuntimeFromEnvironment", () => {
	it.each([[undefined], [""], ["host-worker"]])("is host-worker for %j", (value) => {
		expect(computerRuntimeFromEnvironment({ CHATTICUS_COMPUTER_RUNTIME: value })).toBe("host-worker");
	});

	it("is owner for owner", () => {
		expect(computerRuntimeFromEnvironment({ CHATTICUS_COMPUTER_RUNTIME: "owner" })).toBe("owner");
	});

	it.each(["Owner", "ecs", "host_worker"])("refuses %j", (value) => {
		expect(() => computerRuntimeFromEnvironment({ CHATTICUS_COMPUTER_RUNTIME: value })).toThrow("must be host-worker or owner");
	});
});
