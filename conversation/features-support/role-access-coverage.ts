import type { RecordedAwsRequest } from "./aws-request-recorder.ts";
import { frontDoorRequestsOf } from "./front-door-request-recording.ts";
import { recordedOwnerRequestsOf, recordedSupervisorRequestsOf } from "./owner-request-recording.ts";
import { ACCESS_ROLES, loadRoleAccessManifest, type AccessRole, type AccessRow, type AccessStore } from "../src/gateway/role-access-manifest.ts";
import { requestsTheManifestDoesNotDescribe } from "./role-access-manifest.ts";
import type { ChatticusWorld } from "./world.ts";

let manifestRows: AccessRow[] | null = null;

/** The deployed manifest, read once per process. */
export function roleAccessManifestRows(): AccessRow[] {
	manifestRows ??= loadRoleAccessManifest();
	return manifestRows;
}

/**
 * The store a recorded request went to, by the names the scenarios give their stores: the Conversations table and the
 * PiSessions bucket carry their prefix, every other table is the Messaging table and every other bucket is a snapshot bucket.
 */
export function accessStoreOf(request: RecordedAwsRequest): AccessStore {
	if (request.service === "dynamodb") return request.store.startsWith("Conversations-") ? "conversationsTable" : "messagingTable";
	return request.store.startsWith("pisessions-") ? "piSessionsBucket" : "snapshotBucket";
}

/** The requests each role made in the scenario, as the recording clients noted them. */
export function recordedRequestsByRole(world: ChatticusWorld): Readonly<Record<AccessRole, readonly RecordedAwsRequest[]>> {
	return {
		frontDoor: frontDoorRequestsOf(world),
		ownerTurn: recordedOwnerRequestsOf(world),
		supervisor: recordedSupervisorRequestsOf(world),
		turnExecutor: [],
	};
}

function printRecordedShapes(role: AccessRole, requests: readonly RecordedAwsRequest[]): void {
	if (process.env["CHATTICUS_PRINT_ROLE_ACCESS"] !== "1") return;
	const shapes = new Set(requests.map((request) => `${role}\t${request.action}\t${accessStoreOf(request)}\t${request.keys.join(",")}${request.objectMissing === true ? "\tMISSING" : ""}`));
	for (const shape of shapes) console.info(`role_access ${shape}`);
}

/**
 * What is wrong with the requests the scenario's roles made against the manifest: every request a role sent through a
 * recording client must match a row of that role, and no read of a missing object may hit a row that says the key always exists.
 *
 * @param world The scenario world.
 * @returns One sentence per problem; empty when the manifest describes everything recorded.
 */
export function roleAccessProblemsOf(world: ChatticusWorld): string[] {
	const rows = roleAccessManifestRows();
	const recorded = recordedRequestsByRole(world);
	return ACCESS_ROLES.flatMap((role) => {
		printRecordedShapes(role, recorded[role]);
		return requestsTheManifestDoesNotDescribe(rows, role, recorded[role], accessStoreOf);
	});
}
