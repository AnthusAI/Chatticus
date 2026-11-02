import type { RecordedAwsRequest } from "./aws-request-recorder.ts";
import type { ChatticusWorld } from "./world.ts";

const recordings = new WeakMap<ChatticusWorld, RecordedAwsRequest[]>();

/**
 * Every DynamoDB and S3 request the scenario's erasure worker sent through a recording client, in order. The list is
 * created on first use and is the one the access coverage check judges against the erasure role.
 *
 * @param world The scenario world.
 * @returns The live list the recording clients push into.
 */
export function erasureRequestsOf(world: ChatticusWorld): RecordedAwsRequest[] {
	let sink = recordings.get(world);
	if (sink === undefined) {
		sink = [];
		recordings.set(world, sink);
	}
	return sink;
}
