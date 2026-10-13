import { LIVE_FILE_ERROR_STATUS, type LiveFileErrorCode } from "@chatticus/host-protocol/live-files";

/** What a refusal may carry besides its code and message. */
export type MemberFileRefusalDetail = {
	/** The hash a failed precondition found. */
	readonly currentSha256?: string | null;
	/** When to ask again, in milliseconds. */
	readonly retryAfterMs?: number;
	/** Where the helper kept a copy of what a concurrent writer left behind. */
	readonly keptAs?: string;
	/** Seconds for the Retry-After header of a rate limit. */
	readonly retryAfterSeconds?: number;
};

/**
 * A member's file request the Front Door will not carry out, with the code and status the route answers with
 * (docs/LIVE_FILES_PROTOCOL.md section 6.3). The message never carries file content.
 */
export class MemberFileRefusal extends Error {
	readonly code: LiveFileErrorCode;
	readonly status: number;
	readonly detail: MemberFileRefusalDetail;

	/**
	 * @param code Why.
	 * @param message A description a person can read; no content.
	 * @param detail The hash, retry time or kept copy the answer carries.
	 */
	constructor(code: LiveFileErrorCode, message: string, detail: MemberFileRefusalDetail = {}) {
		super(message);
		this.name = "MemberFileRefusal";
		this.code = code;
		this.status = LIVE_FILE_ERROR_STATUS[code];
		this.detail = detail;
	}
}
