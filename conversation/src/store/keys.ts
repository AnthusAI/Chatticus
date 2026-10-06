/**
 * Key builders for frozen Messaging items (organization, membership, identity, invitation, worker, computer, bot, task, idempotency).
 * Ported from python/src/chatticus/messaging/store.py lines 2723-2800.
 */

/**
 * Build partition and sort keys for organization items.
 * @param tenantId Organization tenant ID.
 * @returns Partition and sort keys.
 */
export function organizationKey(tenantId: string): { pk: string; sk: string } {
	return {
		pk: `${tenantId}#org`,
		sk: "meta",
	};
}

/**
 * Build partition and sort keys for membership items.
 * @param tenantId Organization tenant ID.
 * @param userId User ID.
 * @returns Partition and sort keys.
 */
export function membershipKey(tenantId: string, userId: string): { pk: string; sk: string } {
	return {
		pk: `${tenantId}#org`,
		sk: `member#${userId}`,
	};
}

/**
 * Build partition and sort keys for identity items.
 * @param userId User ID.
 * @returns Partition and sort keys.
 */
export function identityKey(userId: string): { pk: string; sk: string } {
	return {
		pk: `user#${userId}`,
		sk: "identity",
	};
}

/**
 * Build partition and sort keys for invitation items.
 * @param tenantId Organization tenant ID.
 * @param invitationId Invitation ID.
 * @returns Partition and sort keys.
 */
export function invitationKey(tenantId: string, invitationId: string): { pk: string; sk: string } {
	return {
		pk: `${tenantId}#org`,
		sk: `invite#${invitationId}`,
	};
}

/**
 * Build partition and sort keys for worker items.
 * @param tenantId Organization tenant ID.
 * @param workerId Worker ID.
 * @returns Partition and sort keys.
 */
export function workerKey(tenantId: string, workerId: string): { pk: string; sk: string } {
	return {
		pk: `${tenantId}#roster`,
		sk: `worker#${workerId}`,
	};
}

/**
 * Build partition and sort keys for computer items.
 * @param tenantId Organization tenant ID.
 * @param computerId Computer ID.
 * @returns Partition and sort keys.
 */
export function computerKey(tenantId: string, computerId: string): { pk: string; sk: string } {
	return {
		pk: `${tenantId}#computer#${computerId}`,
		sk: "meta",
	};
}

/**
 * Build partition and sort keys for bot items.
 * @param tenantId Organization tenant ID.
 * @param botId Bot ID.
 * @returns Partition and sort keys.
 */
export function botKey(tenantId: string, botId: string): { pk: string; sk: string } {
	return {
		pk: `${tenantId}#roster`,
		sk: `bot#${botId}`,
	};
}

/**
 * Build partition and sort keys for task items.
 * @param tenantId Organization tenant ID.
 * @param taskId Task ID.
 * @returns Partition and sort keys.
 */
export function taskKey(tenantId: string, taskId: string): { pk: string; sk: string } {
	return {
		pk: `${tenantId}#task#${taskId}`,
		sk: "meta",
	};
}

/**
 * Build partition and sort keys for post idempotency items.
 * @param tenantId Organization tenant ID.
 * @param idempotencyKey Idempotency key.
 * @returns Partition and sort keys.
 */
export function postIdempotencyKey(tenantId: string, idempotencyKey: string): { pk: string; sk: string } {
	return {
		pk: `${tenantId}#roster`,
		sk: `idem#${idempotencyKey}`,
	};
}

/**
 * Build partition and sort keys for bot idempotency items.
 * @param tenantId Organization tenant ID.
 * @param idempotencyKey Idempotency key.
 * @returns Partition and sort keys.
 */
export function botIdempotencyKey(tenantId: string, idempotencyKey: string): { pk: string; sk: string } {
	return {
		pk: `${tenantId}#roster`,
		sk: `botidem#${idempotencyKey}`,
	};
}

/**
 * Build partition and sort keys for approval and proposal items.
 * @param tenantId Organization tenant ID.
 * @param approvalId Approval or proposal ID.
 * @returns Partition and sort keys.
 */
export function approvalKey(tenantId: string, approvalId: string): { pk: string; sk: string } {
	return {
		pk: `${tenantId}#approvals`,
		sk: `APPROVAL#${approvalId}`,
	};
}

/**
 * Build partition and sort keys for auto-review rule items.
 * @param tenantId Organization tenant ID.
 * @param ruleId Rule ID.
 * @returns Partition and sort keys.
 */
export function ruleKey(tenantId: string, ruleId: string): { pk: string; sk: string } {
	return {
		pk: `${tenantId}#rules`,
		sk: `RULE#${ruleId}`,
	};
}

/**
 * Build partition and sort keys for authorized connection and proposal items.
 * The partition is the granting tenant.
 * @param grantingTenantId Granting organization tenant ID.
 * @param proposalId Connection proposal ID.
 * @returns Partition and sort keys.
 */
export function connectionKey(grantingTenantId: string, proposalId: string): { pk: string; sk: string } {
	return {
		pk: `${grantingTenantId}#connections`,
		sk: `CONN#${proposalId}`,
	};
}

/**
 * Build partition and sort keys for one member's standing ceiling for one action type.
 * @param tenantId Organization tenant ID.
 * @param memberUserId Member user ID.
 * @param actionType Action type the ceiling bounds.
 * @returns Partition and sort keys.
 */
export function memberCeilingKey(
	tenantId: string,
	memberUserId: string,
	actionType: string,
): { pk: string; sk: string } {
	return {
		pk: `${tenantId}#rules`,
		sk: `CEILING#${memberUserId}#${actionType}`,
	};
}

/**
 * Build partition and sort keys for what one granting tenant permits to leave via connections.
 * @param tenantId Granting organization tenant ID.
 * @returns Partition and sort keys.
 */
export function tenantConnectionEgressKey(tenantId: string): { pk: string; sk: string } {
	return {
		pk: `${tenantId}#rules`,
		sk: "EGRESS#connection",
	};
}

/**
 * Build partition and sort keys for one refused attempt recorded for audit.
 * @param tenantId Organization tenant ID.
 * @param refusalId Refusal ID.
 * @returns Partition and sort keys.
 */
export function refusalKey(tenantId: string, refusalId: string): { pk: string; sk: string } {
	return {
		pk: `${tenantId}#rules`,
		sk: `REFUSAL#${refusalId}`,
	};
}

/**
 * Build partition and sort keys for one computer action. All actions of an organization share one partition, so the host
 * lists what is open for its computer with one query.
 * @param tenantId Organization tenant ID.
 * @param actionId Action ID.
 * @returns Partition and sort keys.
 */
export function computerActionKey(tenantId: string, actionId: string): { pk: string; sk: string } {
	return {
		pk: `${tenantId}#computer#actions`,
		sk: `act#${actionId}`,
	};
}

/**
 * Build partition and sort keys for the index item that finds a turn's computer action by the Pi tool call id.
 * @param tenantId Organization tenant ID.
 * @param turnId Turn ID.
 * @param callId The Pi tool call id.
 * @returns Partition and sort keys.
 */
export function turnActionIndexKey(tenantId: string, turnId: string, callId: string): { pk: string; sk: string } {
	return {
		pk: `${tenantId}#turn#${turnId}`,
		sk: `act#${callId}`,
	};
}
