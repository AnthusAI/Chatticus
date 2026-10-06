import type { CrossAccountRoleInspector, CrossAccountRoleSnapshot } from "../../src/computer/provisioning.ts";

/**
 * Deterministic stand-in for the customer's IAM role: answers the snapshot a scenario configured for one
 * account and role pair. The inspection result is the external system; validation of it is production code.
 */
export class InMemoryCrossAccountRoleInspector implements CrossAccountRoleInspector {
	private readonly snapshots = new Map<string, CrossAccountRoleSnapshot>();

	configure(snapshot: CrossAccountRoleSnapshot): void {
		this.snapshots.set(`${snapshot.accountId}|${snapshot.roleArn}`, snapshot);
	}

	async inspectRole(accountId: string, roleArn: string): Promise<CrossAccountRoleSnapshot> {
		const snapshot = this.snapshots.get(`${accountId}|${roleArn}`);
		if (snapshot === undefined) {
			throw new Error(`No cross-account role snapshot configured for ${JSON.stringify([accountId, roleArn])}.`);
		}
		return snapshot;
	}
}
