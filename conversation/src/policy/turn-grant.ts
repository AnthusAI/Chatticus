/**
 * The capability grant a turn carries and the replacement of it by an enabled member.
 *
 * Ported from python/src/chatticus/control_plane.py lines 1357-1450 (capability_policy_for,
 * set_turn_capability_grant, replace_turn_capability_grant) and python/src/chatticus/http/app.py lines 1860-1887
 * (PUT /turns/{turn_id}/grant). The grant is the item `{tenant}#turn#{turn}` / `grant`, written with the turn when a
 * human message starts it and replaced, never unioned, by the member's grant.
 */

import { pythonRepr } from "../domain/bots.ts";
import { type TurnDependencies, TURN_EVENT_TTL_SECONDS, getTurn } from "../domain/turns.ts";
import { GrantExceedsMemberStandingError, MemberStandingRequiredError, TurnTerminalError } from "../http/errors.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import type { PolicyStore } from "../store/policy-store.ts";
import { ceilingForMemberRole } from "../domain/roles.ts";
import {
	GRANT_STANDING_ACTION_TYPE,
	grantReplaceExceedsActingMemberStanding,
} from "./authorization-ceiling.ts";
import { type TaskCapabilityGrant, grantToPayload } from "./capability-policy.ts";

/** What replacing a turn's grant reads and writes. */
export type TurnGrantDependencies = {
	readonly turns: TurnDependencies;
	readonly store: MessagingStore;
	readonly policyStore: PolicyStore;
};

/**
 * The grant a turn carries.
 *
 * @param deps The turn control store.
 * @param tenantId Organization.
 * @param turnId Turn.
 * @returns The closed grant, or null when the turn carries none (a turn a bot started).
 */
export async function turnCapabilityGrant(
	deps: Pick<TurnGrantDependencies, "turns">,
	tenantId: string,
	turnId: string,
): Promise<TaskCapabilityGrant | null> {
	return deps.turns.store.getGrant(tenantId, turnId);
}

/**
 * Replace the grant of an active turn after checking the acting member's standing, and journal the replacement.
 *
 * @param deps Stores.
 * @param tenantId Organization.
 * @param turnId Turn.
 * @param grant The replacement grant; it is not unioned with the grant it replaces.
 * @param actorUserId The member who replaces it.
 * @throws TurnNotFoundError If the turn is unknown.
 * @throws TurnTerminalError If the turn is not active.
 * @throws MemberStandingRequiredError If the actor is not a member of the organization.
 * @throws GrantExceedsMemberStandingError If the grant is beyond the actor's standing.
 */
export async function replaceTurnCapabilityGrant(
	deps: TurnGrantDependencies,
	tenantId: string,
	turnId: string,
	grant: TaskCapabilityGrant,
	actorUserId: string,
): Promise<void> {
	const turn = await getTurn(deps.turns, tenantId, turnId);
	if (turn.status !== "active") {
		throw new TurnTerminalError(`Turn ${pythonRepr(turnId)} is not active.`);
	}
	const membership = await deps.store.getMembership(tenantId, actorUserId);
	if (membership === null) {
		throw new MemberStandingRequiredError(
			`Member ${pythonRepr(actorUserId)} has no standing in tenant ${pythonRepr(tenantId)}.`,
		);
	}
	const exceeds = await grantReplaceExceedsActingMemberStanding(grant, {
		roleCeiling: ceilingForMemberRole(membership.role),
		grantBoundsCeiling: await deps.policyStore.getMemberCeiling(tenantId, actorUserId, GRANT_STANDING_ACTION_TYPE),
		memberAuthorityCeilingFor: (tool) => deps.policyStore.getMemberCeiling(tenantId, actorUserId, tool),
	});
	if (exceeds) {
		throw new GrantExceedsMemberStandingError(
			`Grant for turn ${pythonRepr(turnId)} exceeds member ${pythonRepr(actorUserId)} standing.`,
		);
	}
	await deps.turns.store.replaceGrant({
		tenantId,
		turnId,
		grant,
		body: JSON.stringify({ actor_user_id: actorUserId, ...grantToPayload(grant) }),
		eventId: deps.turns.ids.next(),
		expiresAt: new Date(deps.turns.clock.now().getTime() + TURN_EVENT_TTL_SECONDS * 1000),
	});
}
