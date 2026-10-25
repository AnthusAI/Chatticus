import type { Clock, IdSource } from "../http/app.ts";
import { botById } from "../domain/bots.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import { normalizedRouteKey } from "../store/channel-store.ts";
import { botMailAddress, mailHandleProblem } from "./mail-handle.ts";
import type { ChannelBinding, ExternalIdentityLink } from "./records.ts";
import type { ChannelsRuntime } from "./runtime.ts";
import type { TransportProvider } from "./transport.ts";

/** Why a binding operation was refused. */
export type BindingRefusal =
	| "unsupported_provider"
	| "bot_not_found"
	| "mail_handle_required"
	| "bot_name_has_no_address"
	| "route_key_required"
	| "route_taken"
	| "mail_handle_invalid"
	| "mail_handle_reserved"
	| "mail_handle_taken"
	| "binding_not_found"
	| "member_not_found"
	| "identity_is_a_route";

/** The outcome of a binding operation. */
export type BindingOutcome<Value> = { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly refusal: BindingRefusal };

/** What the binding operations read and write. */
export interface BindingDependencies {
	readonly runtime: ChannelsRuntime;
	readonly store: MessagingStore;
	readonly ids: IdSource;
	readonly clock: Clock;
}

const refuse = (refusal: BindingRefusal): { ok: false; refusal: BindingRefusal } => ({ ok: false, refusal });

/**
 * Choose the organization's mail handle: a lowercase DNS label, not reserved, unique across the environment.
 *
 * @param deps The dependencies.
 * @param tenantId The organization.
 * @param proposed The handle the owner proposes.
 * @returns The stored handle, or the refusal.
 */
export async function chooseMailHandle(deps: BindingDependencies, tenantId: string, proposed: string): Promise<BindingOutcome<string>> {
	const handle = proposed.trim().toLowerCase();
	const problem = mailHandleProblem(handle);
	if (problem === "not_a_dns_label") return refuse("mail_handle_invalid");
	if (problem === "reserved") return refuse("mail_handle_reserved");
	if (!(await deps.runtime.store.claimMailHandle(tenantId, handle))) return refuse("mail_handle_taken");
	return { ok: true, value: handle };
}

/** What an owner supplies to create a binding. */
export interface NewBinding {
	readonly provider: string;
	readonly botId: string;
	readonly routeKey: string | null;
	readonly createdBy: string;
}

/**
 * Create a binding of an external endpoint to a bot. An email binding's route key is the bot's derived address; every
 * other provider's route key is supplied by the owner.
 *
 * @param deps The dependencies.
 * @param tenantId The organization.
 * @param request The owner's request.
 * @returns The binding, or the refusal.
 */
export async function createChannelBinding(deps: BindingDependencies, tenantId: string, request: NewBinding): Promise<BindingOutcome<ChannelBinding>> {
	const provider = request.provider as TransportProvider;
	if (!deps.runtime.allowedProviders.includes(provider)) return refuse("unsupported_provider");
	const bot = await botById(tenantId, request.botId, deps).catch(() => null);
	if (bot === null) return refuse("bot_not_found");
	let routeKey: string;
	if (provider === "email") {
		const handle = (await deps.runtime.store.getSettings(tenantId)).mailHandle;
		if (handle === null) return refuse("mail_handle_required");
		const address = botMailAddress(bot.name, handle, deps.runtime.mailDomain);
		if (address === null) return refuse("bot_name_has_no_address");
		routeKey = address;
	} else {
		if (request.routeKey === null || request.routeKey.trim() === "") return refuse("route_key_required");
		routeKey = request.routeKey;
	}
	const now = deps.clock.now();
	const binding: ChannelBinding = {
		tenantId,
		bindingId: deps.ids.next(),
		provider,
		routeKey: normalizedRouteKey(routeKey),
		botId: bot.botId,
		enabled: true,
		limits: {},
		createdBy: request.createdBy,
		createdAt: now,
		updatedAt: now,
	};
	if (!(await deps.runtime.store.createBinding(binding))) return refuse("route_taken");
	return { ok: true, value: binding };
}

/**
 * Turn a binding on or off. Turning it off keeps all of its data and stops admission and delivery.
 *
 * @param deps The dependencies.
 * @param tenantId The organization.
 * @param bindingId The binding.
 * @param enabled The new state.
 * @returns The binding, or the refusal.
 */
export async function setChannelBindingEnabled(deps: BindingDependencies, tenantId: string, bindingId: string, enabled: boolean): Promise<BindingOutcome<ChannelBinding>> {
	const binding = await deps.runtime.store.setBindingEnabled(tenantId, bindingId, enabled, deps.clock.now());
	return binding === null ? refuse("binding_not_found") : { ok: true, value: binding };
}

/**
 * Link an external identity to an enabled member of the organization. Milestone 1 trusts the owner who links it;
 * proof of control by the member arrives with the trust classes. An identity equal to any route key of the provider is
 * refused, so a bot's own address can never be a sender that a bot answers.
 *
 * @param deps The dependencies.
 * @param tenantId The organization.
 * @param link The identity, the member and the owner who linked them.
 * @returns The stored link, or the refusal.
 */
export async function linkExternalIdentity(
	deps: BindingDependencies,
	tenantId: string,
	link: { provider: string; externalId: string; userId: string; linkedBy: string },
): Promise<BindingOutcome<ExternalIdentityLink>> {
	const provider = link.provider as TransportProvider;
	if (!deps.runtime.allowedProviders.includes(provider)) return refuse("unsupported_provider");
	if ((await deps.store.getMembership(tenantId, link.userId)) === null) return refuse("member_not_found");
	const externalId = link.externalId.trim().toLowerCase();
	if ((await deps.runtime.store.resolveRoute(provider, normalizedRouteKey(externalId))) !== null) return refuse("identity_is_a_route");
	const stored: ExternalIdentityLink = {
		tenantId,
		provider,
		externalId,
		userId: link.userId,
		linkedBy: link.linkedBy,
		linkedAt: deps.clock.now(),
	};
	await deps.runtime.store.putIdentityLink(stored);
	return { ok: true, value: stored };
}
