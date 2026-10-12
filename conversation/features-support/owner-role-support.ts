import { computerForOrganization } from "../src/domain/computers.ts";
import { getTurn } from "../src/domain/turns.ts";
import { ownerSessionTags, supervisorSessionTags, type OwnerSessionScope } from "../src/gateway/session-tags.ts";
import type { S3SnapshotStore } from "../src/snapshot/s3.ts";
import { tableArnOf } from "./aws-request-recorder.ts";
import { computerOwnerScenarioOf } from "./computer-owner.ts";
import { STORY_TENANT } from "./computer-scenario.ts";
import { ownerRolePolicyStatements, supervisorRolePolicyStatements, type PolicyStatement, type SessionTagValues } from "./iam-policy-evaluator.ts";
import { ensurePiStorage } from "./pi-storage.ts";
import type { ChatticusWorld } from "./world.ts";

/** The owner role as a session of it sees it: the permission statements and the tags the session carries. */
export type OwnerRole = {
	readonly statements: PolicyStatement[];
	readonly tags: SessionTagValues;
};

/** The names of the stores whose ARNs the policy needs. */
export type OwnerRoleStores = {
	readonly piSessionsBucket: string;
	readonly snapshotBucket: string;
	readonly conversationsTable: string;
	readonly messagingTable: string;
};

/** The store names the owner role scenarios use when they do not run against real stores. */
export const FIXED_STORE_NAMES: OwnerRoleStores = {
	piSessionsBucket: "pi-sessions",
	snapshotBucket: "snapshots",
	conversationsTable: "conversations",
	messagingTable: "messaging",
};

/**
 * The owner role for one session, built the way the starter and the stack build it: the tags from `ownerSessionTags` and
 * the statements from the policy file the CDK stack deploys.
 *
 * @param scope The session.
 * @param stores The names of the stores.
 * @returns The statements and the tag values.
 */
export function ownerRoleFor(scope: OwnerSessionScope, stores: OwnerRoleStores = FIXED_STORE_NAMES): OwnerRole {
	return {
		statements: ownerRolePolicyStatements({
			piSessionsBucketArn: `arn:aws:s3:::${stores.piSessionsBucket}`,
			conversationsTableArn: tableArnOf(stores.conversationsTable),
			messagingTableArn: tableArnOf(stores.messagingTable),
		}),
		tags: Object.fromEntries(ownerSessionTags(scope).map((tag) => [tag.Key, tag.Value])),
	};
}

/**
 * The supervisor role of the scenario's computer, built the way the broker builds it: the tags from `supervisorSessionTags`
 * and the statements from the policy file the CDK stack deploys, over the scenario's snapshot bucket.
 */
export async function supervisorRoleOfScenario(world: ChatticusWorld): Promise<OwnerRole> {
	const computer = await computerForOrganization(STORY_TENANT, { store: world.messagingStore() });
	const snapshotBucket = (world.snapshotStore as S3SnapshotStore | null)?.bucket ?? "owner-snapshots-unbound";
	return {
		statements: supervisorRolePolicyStatements({ snapshotBucketArn: `arn:aws:s3:::${snapshotBucket}` }),
		tags: Object.fromEntries(supervisorSessionTags({ tenantId: STORY_TENANT, computerId: computer.computerId }).map((tag) => [tag.Key, tag.Value])),
	};
}

/** The owner role of the scenario's first turn, over the scenario's real stores. */
export async function ownerRoleOfScenario(world: ChatticusWorld): Promise<OwnerRole> {
	const scenario = computerOwnerScenarioOf(world);
	const turnId = scenario.turnIds[0] ?? world.lastTurnId;
	if (turnId === undefined || turnId === null) throw new Error("The scenario started no turn.");
	const turn = await getTurn(world.turnDependencies(), STORY_TENANT, turnId);
	const storage = await ensurePiStorage(world);
	const computer = await computerForOrganization(STORY_TENANT, { store: world.messagingStore() });
	const snapshotBucket = (world.snapshotStore as S3SnapshotStore | null)?.bucket ?? "owner-snapshots-unbound";
	return ownerRoleFor(
		{ tenantId: STORY_TENANT, botId: turn.botId, channelId: turn.channelId, computerId: computer.computerId, turnId },
		{
			piSessionsBucket: storage.bucket,
			snapshotBucket,
			conversationsTable: storage.tableName,
			messagingTable: world.messagingTable.tableName,
		},
	);
}
