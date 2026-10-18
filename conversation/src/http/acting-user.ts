import { PrincipalHttpError, type Principal } from "../auth/principal.ts";
import type { Channel } from "../domain/channels.ts";
import type { MessagingStore } from "../store/messaging-store.ts";

/** Refuse a request that names an acting user other than the signed-in caller, whatever the caller's kind. */
export function assertActingUserId(principal: Principal, actingUserId: string): void {
	if (principal.userId === null || actingUserId !== principal.userId) {
		throw new PrincipalHttpError(403, "the acting user must be the signed-in user");
	}
}

/** Refuse a request that reads another user's records unless the caller owns the organization. */
export function assertMayReadUserRecords(principal: Principal, recordsOwnerUserId: string): void {
	if (principal.userId === recordsOwnerUserId || principal.role === "owner") {
		return;
	}
	throw new PrincipalHttpError(403, "only the user themselves or an organization owner may read this user's records");
}

/** Refuse a caller who does not take part in the channel as a human. */
export function assertHumanParticipantOfChannel(principal: Principal, channel: Channel): void {
	const takesPart = channel.participants.some(
		(participant) => participant.kind === "human" && participant.actorId === principal.userId,
	);
	if (!takesPart) {
		throw new PrincipalHttpError(403, "the signed-in user is not a participant of this channel");
	}
}

/**
 * Refuse a caller who is not a participant of the channel. A channel that does not exist passes here so the route's
 * own not-found answer stays unchanged.
 */
export async function assertCallerParticipatesInChannel(
	principal: Principal,
	tenantId: string,
	channelId: string,
	deps: { store: MessagingStore },
): Promise<void> {
	const channel = await deps.store.getChannel(tenantId, channelId);
	if (channel === null) {
		return;
	}
	assertHumanParticipantOfChannel(principal, channel);
}
