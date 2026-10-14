import {
	OwnerCredentialBrokerError,
	type OwnerCredentialBrokerPort,
	type SupervisorGrant,
	type SupervisorGrantRequest,
	type SupervisorRenewalGrant,
	type SupervisorRenewalGrantRequest,
	type TurnGrant,
	type TurnGrantRequest,
} from "../src/computer/owner-credential-broker.ts";
import { FakeOwnerCredentialBroker } from "./fakes/fake-owner-credential-broker.ts";
import { SCENARIO_GATEWAY_SIGNING_KEY } from "./model-gateway-support.ts";
import type { ChatticusWorld } from "./world.ts";

/**
 * The scenario's credential broker as the Front Door sees it: the fake that mints real tokens with the scenario key and
 * records every request, which a scenario can also make unreachable and reachable again.
 */
export class ScenarioOwnerCredentialBroker implements OwnerCredentialBrokerPort {
	readonly fake: FakeOwnerCredentialBroker;
	/** How many calls reached the port, counted when a call arrives, before the broker answers or is held. */
	arrivals = 0;
	private unreachable = false;

	constructor(world: ChatticusWorld) {
		this.fake = new FakeOwnerCredentialBroker(SCENARIO_GATEWAY_SIGNING_KEY, world.clock);
	}

	/** Make every call fail as an unreachable broker does until {@link setReachable} is called with true. */
	setReachable(reachable: boolean): void {
		this.unreachable = !reachable;
	}

	issue(request: SupervisorGrantRequest): Promise<SupervisorGrant>;
	issue(request: SupervisorRenewalGrantRequest): Promise<SupervisorRenewalGrant>;
	issue(request: TurnGrantRequest): Promise<TurnGrant>;
	async issue(
		request: SupervisorGrantRequest | SupervisorRenewalGrantRequest | TurnGrantRequest,
	): Promise<SupervisorGrant | SupervisorRenewalGrant | TurnGrant> {
		this.arrivals += 1;
		if (this.unreachable) {
			this.fake.calls.push({ request, tags: [] });
			throw new OwnerCredentialBrokerError("broker_unreachable", "The scenario made the broker unreachable.");
		}
		if (request.purpose === "supervisor") return this.fake.issue(request);
		if (request.purpose === "supervisor_renewal") return this.fake.issue(request);
		return this.fake.issue(request);
	}
}

const brokers = new WeakMap<ChatticusWorld, ScenarioOwnerCredentialBroker>();

/** The scenario's credential broker, created on first use; every front door the scenario wires holds this one. */
export function ownerBrokerOf(world: ChatticusWorld): ScenarioOwnerCredentialBroker {
	let broker = brokers.get(world);
	if (broker === undefined) {
		broker = new ScenarioOwnerCredentialBroker(world);
		brokers.set(world, broker);
	}
	return broker;
}
