import { DynamoBudgetStore } from "../src/budget/budget-store.ts";
import { DynamoComputerActionStore } from "../src/store/action-store.ts";
import { DynamoMessagingStore } from "../src/store/dynamo-messaging-store.ts";
import { DynamoTurnControlStore } from "../src/store/turn-store.ts";
import { S3SnapshotStore } from "../src/snapshot/s3.ts";
import type { SnapshotObjectStore } from "../src/snapshot/store.ts";
import type { ExecutorDeps } from "../src/turn/types.ts";
import { NO_OP_COMPUTER_STARTS } from "../../computer/host/src/owner-deps.ts";
import { recordingDynamoClient, recordingS3Client, type RecordedAwsRequest } from "./aws-request-recorder.ts";
import { gatedRenewals } from "./executor-harness.ts";
import { testS3Client } from "./pi-storage.ts";
import type { ChatticusWorld } from "./world.ts";

const recordings = new WeakMap<ChatticusWorld, RecordedAwsRequest[]>();

/** Start recording the requests of the computer owners of the scenario; owners started afterwards use recording clients. */
export function startRecordingOwnerRequests(world: ChatticusWorld): RecordedAwsRequest[] {
	let sink = recordings.get(world);
	if (sink === undefined) {
		sink = [];
		recordings.set(world, sink);
	}
	return sink;
}

/** The requests the scenario's computer owners made so far, in order; empty when the scenario does not record. */
export const recordedOwnerRequestsOf = (world: ChatticusWorld): readonly RecordedAwsRequest[] => recordings.get(world) ?? [];

/** Whether the scenario records its computer owners' requests. */
export const isRecordingOwnerRequests = (world: ChatticusWorld): boolean => recordings.has(world);

/**
 * The executor's dependencies with every store the owner reaches built over a recording client, the way
 * `createContainerOwnerDeps` builds them over the credentials of the container, so each request of the owner is noted
 * and no request of the scenario's other steps is.
 *
 * @param world The scenario world.
 * @param deps The dependencies the scenario would give an unrecorded owner.
 * @param renewalGate Lease renewals wait for this promise, as in the unrecorded owner.
 * @returns Dependencies whose Messaging, Conversations and bucket requests are recorded.
 */
export function withRecordedOwnerRequests(world: ChatticusWorld, deps: ExecutorDeps, renewalGate?: Promise<void>): ExecutorDeps {
	const sink = startRecordingOwnerRequests(world);
	const client = recordingDynamoClient(world.messagingTable.client, sink);
	const table = deps.messagingTableName;
	return {
		...deps,
		turns: gatedRenewals({ store: new DynamoTurnControlStore(client, table), clock: deps.turns.clock, ids: deps.turns.ids }, renewalGate),
		messaging: new DynamoMessagingStore(client, table),
		client,
		s3: recordingS3Client(deps.s3, sink),
		ledger: { ...deps.ledger, client },
		computer: {
			...deps.computer,
			actions: new DynamoComputerActionStore(client, table),
			computerStarts: NO_OP_COMPUTER_STARTS,
			rollups: new DynamoBudgetStore(client, table),
		},
	};
}

/** The snapshot store an owner hydrates from and publishes to: over a recording client when the scenario records. */
export function snapshotStoreForOwner(world: ChatticusWorld, store: SnapshotObjectStore): SnapshotObjectStore {
	if (!isRecordingOwnerRequests(world) || !(store instanceof S3SnapshotStore)) return store;
	return new S3SnapshotStore(store.bucket, recordingS3Client(testS3Client(), startRecordingOwnerRequests(world)));
}
