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
