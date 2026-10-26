import type { ChannelStore } from "./records.ts";
import type { ChannelEventPublisher } from "./events.ts";
import type { ChannelMetrics } from "./metrics.ts";
import type { ChannelTransport, TransportProvider } from "./transport.ts";

/**
 * Everything the external channel features depend on in one deployment. It exists only where the capability is rolled
 * out; where it is absent the owner routes answer as if the feature did not exist and nothing is admitted or delivered.
 */
export interface ChannelsRuntime {
	readonly store: ChannelStore;
	/** The environment's mail domain; an email address is `<bot>@<mail handle>.<mail domain>`. */
	readonly mailDomain: string;
	/** The providers an owner may create a binding for in this environment. */
	readonly allowedProviders: readonly TransportProvider[];
	/** The per-environment kill switch: while engaged nothing is admitted or delivered anywhere in the environment. */
	readonly killSwitchEngaged: boolean;
	/** The transport adapters, one per provider this environment can deliver through. */
	readonly transports: ReadonlyMap<TransportProvider, ChannelTransport>;
	/** The secret that keys the plus-tag hash which lets a reply find its thread when a mail client drops every header. */
	readonly correlatorSecret: string;
	readonly events: ChannelEventPublisher;
	readonly metrics: ChannelMetrics;
}

/**
 * Whether external channels are on for one organization: the environment kill switch is off and the operator has
 * switched the organization on.
 *
 * @param runtime The deployment's channel runtime.
 * @param tenantId The organization.
 * @returns True when bindings may be managed and messages admitted and delivered.
 */
export async function externalChannelsAvailable(runtime: ChannelsRuntime, tenantId: string): Promise<boolean> {
	if (runtime.killSwitchEngaged) return false;
	return (await runtime.store.getSettings(tenantId)).externalChannelsEnabled;
}
