import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { S3Client } from "@aws-sdk/client-s3";
import { recordingDynamoClient, recordingS3Client, type RecordedAwsRequest } from "./aws-request-recorder.ts";
import type { ChatticusWorld } from "./world.ts";

type ListingProbe = { readonly requests: RecordedAwsRequest[]; deniedReads: boolean };

const probes = new WeakMap<ChatticusWorld, ListingProbe>();

const probeOf = (world: ChatticusWorld): ListingProbe => {
	let probe = probes.get(world);
	if (probe === undefined) {
		probe = { requests: [], deniedReads: false };
		probes.set(world, probe);
	}
	return probe;
};

const WRITE_ACTIONS = /^(dynamodb:(PutItem|UpdateItem|DeleteItem|BatchWriteItem)|s3:(PutObject|DeleteObject|CopyObject|CreateMultipartUpload))$/;

const accessDenied = (): Error => {
	const error = new Error("User is not authorized to perform this action on the resource");
	error.name = "AccessDeniedException";
	return error;
};

function denyingReads<Client extends object>(world: ChatticusWorld, client: Client, deniedTable: string | null): Client {
	return new Proxy(client, {
		get(target, property, receiver) {
			if (property !== "send") return Reflect.get(target, property, receiver);
			return (...args: unknown[]) => {
				const table = (args[0] as { input?: { TableName?: string } } | undefined)?.input?.TableName;
				const inDeniedStore = deniedTable === null || table === deniedTable;
				if (probeOf(world).deniedReads && inDeniedStore) return Promise.reject(accessDenied());
				return (target as unknown as { send: (...sendArgs: unknown[]) => unknown }).send(...args);
			};
		},
	});
}

/**
 * The clients the Front Door lists messages with, wrapped so a scenario can see every request they make and make every
 * request to the session store (the Conversations table and the bucket) fail with AccessDenied while the Messaging
 * table keeps answering, as the Front Door's role would if its session reads were revoked.
 *
 * @param world The scenario world.
 * @param clients The unwrapped clients.
 * @param sessionTableName The Conversations table the denial applies to.
 * @returns Clients that note each request in the scenario's probe and honour its denial switch.
 */
export function probedListingClients(
	world: ChatticusWorld,
	clients: { client: DynamoDBClient; s3: S3Client },
	sessionTableName: string,
): { client: DynamoDBClient; s3: S3Client } {
	const probe = probeOf(world);
	return {
		client: denyingReads(world, recordingDynamoClient(clients.client, probe.requests), sessionTableName),
		s3: denyingReads(world, recordingS3Client(clients.s3, probe.requests), null),
	};
}

/** Forget the requests noted so far, so a scenario judges only what follows. */
export function clearListingRequests(world: ChatticusWorld): void {
	probeOf(world).requests.length = 0;
}

/** Make every session store request the Front Door's message listing sends fail with AccessDenied from now on. */
export function denyListingRequests(world: ChatticusWorld): void {
	probeOf(world).deniedReads = true;
}

/** The requests the Front Door's message listing sent that change state, in order. */
export function listingWrites(world: ChatticusWorld): readonly RecordedAwsRequest[] {
	return probeOf(world).requests.filter((request) => WRITE_ACTIONS.test(request.action));
}

/** Every request the Front Door's message listing sent since the last clear, in order. */
export function listingRequests(world: ChatticusWorld): readonly RecordedAwsRequest[] {
	return probeOf(world).requests;
}
