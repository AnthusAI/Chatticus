import type { RecordedAwsRequest } from "./aws-request-recorder.ts";
import type { ChatticusWorld } from "./world.ts";

const recordings = new WeakMap<ChatticusWorld, RecordedAwsRequest[]>();

/**
 * Every DynamoDB and S3 request the scenario's Front Door sent through a recording client, in order: its message
 * listing, its snapshot file reads and the edit overlay it keeps in the snapshot bucket. The list is created on first use
 * and is the one the access coverage check judges against the Front Door role.
 *
 * @param world The scenario world.
 * @returns The live list the recording clients push into.
 */
export function frontDoorRequestsOf(world: ChatticusWorld): RecordedAwsRequest[] {
	let sink = recordings.get(world);
	if (sink === undefined) {
		sink = [];
		recordings.set(world, sink);
	}
	return sink;
}
