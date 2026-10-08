import { describe, expect, it } from "vitest";
import { OwnerConfigurationError, ownerStoresConfigFromEnvironment } from "../../computer/host/src/owner-deps.ts";
import { createGatewayModels } from "../../computer/host/src/owner-models.ts";
import { startJobSourceFromEnvironment } from "../../computer/host/src/owner.ts";

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
