import type { GatewayLogEvent, ModelGatewayDependencies } from "../src/gateway/model-gateway.ts";
import { ledgerDependenciesFor } from "./executor-harness.ts";
import { startFakeResponsesVendor, type FakeResponsesVendor } from "./fakes/fake-responses-vendor.ts";
import type { ChatticusWorld } from "./world.ts";

/** The signing key a scenario's gateway verifies tokens with. */
export const SCENARIO_GATEWAY_SIGNING_KEY = "scenario-gateway-signing-key-0123456789";

/** The vendor key the scenario's gateway holds; no response, header or log line may ever contain it. */
export const SCENARIO_VENDOR_KEY = "sk-real-vendor-key-that-must-stay-home";

/** What is true about the gateway during one scenario. */
export type GatewayScenario = {
	vendor: FakeResponsesVendor | null;
	readonly logEvents: GatewayLogEvent[];
	readonly consoleLines: string[];
	lastResponse: Response | null;
	lastBody: string;
	lastToken: string;
	/** Tokens minted for named turns, by label. */
	readonly tokens: Map<string, string>;
};

const scenarios = new WeakMap<ChatticusWorld, GatewayScenario>();

/** The scenario's gateway state, created on first use. */
export function gatewayScenarioOf(world: ChatticusWorld): GatewayScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = { vendor: null, logEvents: [], consoleLines: [], lastResponse: null, lastBody: "", lastToken: "", tokens: new Map() };
		scenarios.set(world, scenario);
	}
	return scenario;
}

/** The scenario's fake vendor, started on first use. */
export async function vendorOf(world: ChatticusWorld): Promise<FakeResponsesVendor> {
	const scenario = gatewayScenarioOf(world);
	if (scenario.vendor === null) scenario.vendor = await startFakeResponsesVendor();
	return scenario.vendor;
}

/** Stop the scenario's fake vendor, when one was started. */
export async function closeGatewayScenario(world: ChatticusWorld): Promise<void> {
	const scenario = scenarios.get(world);
	if (scenario?.vendor) await scenario.vendor.close();
}

/** The gateway as every scenario's front door mounts it: real forwarding over loopback to the scenario's fake vendor. */
export function modelGatewayFor(world: ChatticusWorld): ModelGatewayDependencies {
	const scenario = gatewayScenarioOf(world);
	return {
		signingKey: SCENARIO_GATEWAY_SIGNING_KEY,
		clock: world.clock,
		turns: world.turnControlStore(),
		ledger: ledgerDependenciesFor(world),
		upstream: {
			get baseUrl() {
				return scenario.vendor?.baseUrl ?? "http://127.0.0.1:1/v1";
			},
			apiKey: SCENARIO_VENDOR_KEY,
			fetch: (input, init) => fetch(input, init),
		},
		log: (event) => {
			scenario.logEvents.push(event);
			scenario.consoleLines.push(JSON.stringify(event));
		},
	};
}
