import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type SubmissionRecord } from "@earendil-works/pi-durable";
import type { Turn } from "../domain/turns.ts";
import { IndexedStorage } from "../storage/indexed-storage.ts";
import { storageIdFor } from "../storage/storage-support.ts";
import type { SubmissionInspector } from "../turn/probes.ts";

/** The request identifier the executor submits a turn's prompt under. */
export const turnRequestId = (turnId: string): string => `turn:${turnId}`;

/**
 * Read a turn's prompt submission from a session without owning it: a storage opened with no fence needs no ownership to
 * read, and the lookup by request identifier is a plain read. This is how a probe learns, after an owner died without
 * closing its session, that the model had already answered.
 *
 * @param storage A storage opened without a fence.
 * @param turnId The turn.
 * @param context Cancellation context.
 * @returns The submission record, or undefined when the session never saw the prompt.
 */
export async function readTurnSubmission(
	storage: Pick<IndexedStorage, "submissionByRequest">,
	turnId: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<SubmissionRecord | undefined> {
	return storage.submissionByRequest(ROOT_CONVERSATION_ID, turnRequestId(turnId), context);
}

/** What the inspector needs to find a session. */
export type PiSubmissionInspectorOptions = {
	readonly client: DynamoDBClient;
	readonly s3: S3Client;
	readonly tableName: string;
	readonly bucket: string;
};

/** A SubmissionInspector over the Pi sessions in DynamoDB and S3. */
export class PiSubmissionInspector implements SubmissionInspector {
	private readonly options: PiSubmissionInspectorOptions;

	constructor(options: PiSubmissionInspectorOptions) {
		this.options = options;
	}

	async turnAnswered(turn: Turn): Promise<boolean> {
		const storage = await IndexedStorage.open({
			...this.options,
			storageId: storageIdFor(turn.tenantId, turn.botId, turn.channelId),
		});
		const record = await readTurnSubmission(storage, turn.turnId);
		return record?.type === "input" && record.status === "done";
	}
}
