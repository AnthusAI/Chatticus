import { z } from "zod";
import { LIVE_FILE_PATH_MAX_CHARACTERS, livePathProblem, utf8ByteLength } from "./live-file-rules.ts";

/** How long the Front Door waits for an owner's answer; also the largest `expires_in_ms`. */
export const LIVE_FILE_WAIT_MILLISECONDS = 8000;
/** The interval of the Front Door's wait loop. */
export const LIVE_FILE_RESULT_CHECK_MILLISECONDS = 250;
/** The extra wait for a delivered write before `outcome_unknown`. */
export const LIVE_FILE_OUTCOME_GRACE_MILLISECONDS = 7000;
/** The `expires_at` backstop of a file request item. */
export const LIVE_FILE_OPERATION_TTL_SECONDS = 120;
/** How long the interactive poll pace lasts after a ping or a request. */
export const LIVE_FILE_INTERACTIVE_WINDOW_SECONDS = 45;
/** How often the open Files panel pings. */
export const LIVE_FILE_WATCH_INTERVAL_SECONDS = 15;
/** The most file requests one poll delivers. */
export const LIVE_FILE_MAX_REQUESTS_PER_POLL = 4;
/** The most open file requests per computer. */
export const LIVE_FILE_MAX_OPEN_OPERATIONS = 16;
/** The most helper processes the supervisor runs at once. */
export const LIVE_FILE_MAX_CONCURRENT_HELPERS = 2;
/** The most requests the supervisor queues before answering `owner_busy`. */
export const LIVE_FILE_MAX_QUEUED_REQUESTS = 8;
/** The supervisor's timeout for one helper operation. */
export const LIVE_FILE_HELPER_TIMEOUT_MILLISECONDS = 6000;
/** The memory use beyond which the supervisor answers `owner_busy`. */
export const LIVE_FILE_MEMORY_REFUSE_PERCENT = 90;
/** The most bytes one read range or one write body carries. */
export const LIVE_FILE_CONTENT_MAX_BYTES = 262144;
/** The largest file the helper reads. */
export const LIVE_FILE_READ_MAX_FILE_BYTES = 8388608;
/** The most entries one listing returns. */
export const LIVE_FILE_LISTING_MAX_ENTRIES = 2000;
/** The most names the helper scans for one listing. */
export const LIVE_FILE_LISTING_SCAN_MAX_NAMES = 20000;
/** The most descendants a directory delete, rename or tree hash covers. */
export const LIVE_FILE_TREE_MAX_ENTRIES = 5000;
/** The most standard output the supervisor reads from the helper. */
export const LIVE_FILE_STDOUT_MAX_BYTES = 1048576;
/** The length of one rate counter window. */
export const LIVE_FILE_RATE_WINDOW_SECONDS = 60;
/** Reads per user per window. */
export const LIVE_FILE_READ_RATE = 240;
/** Writes (including delete, move and mkdir) per user per window. */
export const LIVE_FILE_WRITE_RATE = 30;
/** Reveals per user per window. */
export const LIVE_FILE_REVEAL_RATE = 10;
/** Watch pings per user per window. */
export const LIVE_FILE_WATCH_RATE = 12;
/** How long audit records are kept. */
export const LIVE_FILE_AUDIT_RETENTION_DAYS = 90;
/** The age after which a pending audit record is read as unknown. */
export const LIVE_FILE_PENDING_AUDIT_UNKNOWN_SECONDS = 120;
/** The smallest `retry_after_ms`. */
export const LIVE_FILE_RETRY_AFTER_MIN_MILLISECONDS = 1000;
/** The largest `retry_after_ms`. */
export const LIVE_FILE_RETRY_AFTER_MAX_MILLISECONDS = 10000;

/** The permission bits of a directory the helper creates, before the umask of the launcher. */
export const LIVE_FILE_MKDIR_MODE = 0o775;

const identifier = z.string().min(1).max(256);
const timestamp = z.iso.datetime();
const generation = z.number().int().positive();
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const mode = z.string().regex(/^[0-7]{3,4}$/);

/** A path under /workspace, lexically valid. The same rules as livePathProblem; the issue message names the problem. */
export const livePathSchema = z.string().max(LIVE_FILE_PATH_MAX_CHARACTERS).superRefine((value, context) => {
	const problem = livePathProblem(value);
	if (problem !== null) context.addIssue({ code: "custom", message: `not a workspace path: ${problem}` });
});

/** UTF-8 text a person may save: at most 256 KiB, no NUL. */
export const liveFileTextSchema = z.string().refine(
	(text) => utf8ByteLength(text) <= LIVE_FILE_CONTENT_MAX_BYTES && !text.includes("\u0000"),
	{ message: "content must be UTF-8 text of at most 262144 bytes with no NUL" },
);

/** One directory entry, the same shape for a live listing and a snapshot listing. */
export const liveFileEntrySchema = z
	.object({
		name: z.string().min(1).max(255),
		path: livePathSchema,
		kind: z.enum(["file", "directory", "symlink"]),
		size: z.number().int().nonnegative().nullable(),
		mode: mode.nullable(),
		sha256: sha256Hex.nullable(),
		link_target: z.string().max(4096).nullable(),
		modified_at: timestamp.nullable(),
		/** "pending": an overlay change is in effect; "conflict": the person's change conflicts with a newer snapshot (the entry shows theirs). */
		overlay: z.enum(["none", "pending", "conflict"]),
		/** Only on the stat of a directory: its tree hash (L49), the ETag of a delete or rename. */
		tree_sha256: sha256Hex.nullable(),
	})
	.strict();

/** What a write must find on the disk. "if_match" replaces a file with this hash; "if_none_match" creates a file that must not exist. */
export const liveFileWritePreconditionSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("if_match"), sha256: sha256Hex }).strict(),
	z.object({ type: z.literal("if_none_match") }).strict(),
]);

/** What a delete or a move must find: the content hash of a file or symlink, or the tree hash of a directory (L49). */
export const liveFileRemovePreconditionSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("if_match"), sha256: sha256Hex }).strict(),
	z.object({ type: z.literal("if_match_tree"), tree_sha256: sha256Hex }).strict(),
]);

const requestBase = {
	operation_id: identifier,
	path: livePathSchema,
	expires_in_ms: z.number().int().min(0).max(LIVE_FILE_WAIT_MILLISECONDS),
};

/**
 * One file request the poll hands to the owner. Not strict: a newer server may add a field an older owner ignores.
 * `expires_in_ms` is relative to the moment the owner received the answer; the owner measures it with its own clock and
 * answers `expired`, without touching the disk, if it cannot start the operation in that time.
 */
export const ownerFileRequestSchema = z.discriminatedUnion("kind", [
	z.object({ ...requestBase, kind: z.literal("list"), max_entries: z.number().int().min(1).max(LIVE_FILE_LISTING_MAX_ENTRIES) }),
	z.object({ ...requestBase, kind: z.literal("stat"), tree: z.boolean().default(false) }),
	z.object({
		...requestBase,
		kind: z.literal("read"),
		offset: z.number().int().min(0),
		length: z.number().int().min(1).max(LIVE_FILE_CONTENT_MAX_BYTES),
		mask: z.boolean(),
	}),
	z.object({ ...requestBase, kind: z.literal("write"), content: liveFileTextSchema, precondition: liveFileWritePreconditionSchema }),
	z.object({ ...requestBase, kind: z.literal("delete"), recursive: z.boolean(), precondition: liveFileRemovePreconditionSchema }),
	z.object({ ...requestBase, kind: z.literal("move"), to: livePathSchema, precondition: liveFileRemovePreconditionSchema }),
	z.object({ ...requestBase, kind: z.literal("mkdir") }),
]);

/** Why an owner could not carry out a request. */
export const LIVE_FILE_OWNER_ERROR_CODES = [
	"not_found",
	"not_a_file",
	"not_a_directory",
	"outside_workspace",
	"permission_denied",
	"file_too_large",
	"already_exists",
	"precondition_failed",
	"parent_missing",
	"not_text",
	"path_refused",
	"expired",
	"owner_stopping",
	"owner_busy",
	"helper_failed",
	"helper_timeout",
	"io_error",
	"directory_not_empty",
	"invalid_move",
	"too_many_entries",
] as const;
export const liveFileOwnerErrorCodeSchema = z.enum(LIVE_FILE_OWNER_ERROR_CODES);

const listResult = z
	.object({
		kind: z.literal("list"),
		resolved_path: livePathSchema,
		entries: z.array(liveFileEntrySchema).max(LIVE_FILE_LISTING_MAX_ENTRIES),
		truncated: z.boolean(),
	})
	.strict();

const statResult = z.object({ kind: z.literal("stat"), entry: liveFileEntrySchema }).strict();

const readResult = z
	.object({
		kind: z.literal("read"),
		resolved_path: livePathSchema,
		size: z.number().int().nonnegative(),
		sha256: sha256Hex,
		mode,
		modified_at: timestamp,
		encoding: z.enum(["utf8", "base64"]),
		binary: z.boolean(),
		offset: z.number().int().nonnegative(),
		length: z.number().int().min(0).max(LIVE_FILE_CONTENT_MAX_BYTES),
		content: z.string(),
		truncated: z.boolean(),
		masked: z.boolean(),
	})
	.strict()
	.refine((result) => !result.masked || (result.content === "" && result.length === 0), { message: "a masked read carries no content" });

const writeResult = z
	.object({
		kind: z.literal("write"),
		resolved_path: livePathSchema,
		created: z.boolean(),
		size: z.number().int().nonnegative(),
		sha256_before: sha256Hex.nullable(),
		sha256_after: sha256Hex,
		modified_at: timestamp,
		kept_as: livePathSchema.optional(),
	})
	.strict();

const deleteResult = z
	.object({
		kind: z.literal("delete"),
		resolved_path: livePathSchema,
		directory: z.boolean(),
		removed: z.number().int().nonnegative().max(LIVE_FILE_TREE_MAX_ENTRIES),
		sha256_before: sha256Hex.nullable(),
		tree_sha256_before: sha256Hex.nullable(),
		kept_as: livePathSchema.optional(),
	})
	.strict();

const moveResult = z
	.object({
		kind: z.literal("move"),
		from: livePathSchema,
		to: livePathSchema,
		directory: z.boolean(),
		sha256: sha256Hex.nullable(),
		tree_sha256: sha256Hex.nullable(),
	})
	.strict();

const mkdirResult = z.object({ kind: z.literal("mkdir"), resolved_path: livePathSchema, created: z.boolean() }).strict();

/** The owner's answer to one request: the result, or the code of the error that stopped it. */
export const liveFileOutcomeSchema = z.discriminatedUnion("status", [
	z.object({ status: z.literal("ok"), result: z.discriminatedUnion("kind", [listResult, statResult, readResult, writeResult, deleteResult, moveResult, mkdirResult]) }).strict(),
	z
		.object({
			status: z.literal("error"),
			code: liveFileOwnerErrorCodeSchema,
			message: z.string().max(500),
			current_sha256: sha256Hex.nullable().optional(),
		})
		.strict(),
]);

/** POST /orgs/{tenant}/host/owner/file-results: the supervisor posts the answer to one request. */
export const ownerFileResultRequestSchema = z
	.object({ owner_id: identifier, generation, operation_id: identifier, outcome: liveFileOutcomeSchema })
	.strict();

/** The answer: the result is recorded (also when it repeats one already recorded, byte for byte). */
export const ownerFileResultResponseSchema = z.object({ recorded: z.literal(true) });

/** Why a member-facing file response came from the snapshot although a live computer exists. */
export const liveFileFallbackReasonSchema = z.enum([
	"owner_timeout",
	"owner_error",
	"owner_not_ready",
	"owner_too_old",
	"owner_warming",
	"owner_stopping",
]);

/** The fields every member-facing list, stat and content response carries. */
export const liveFileProvenanceShape = {
	source: z.enum(["live", "snapshot"]),
	as_of: timestamp.nullable(),
	stale: z.boolean(),
	fallback_reason: liveFileFallbackReasonSchema.nullable(),
	retry_after_ms: z.number().int().min(LIVE_FILE_RETRY_AFTER_MIN_MILLISECONDS).max(LIVE_FILE_RETRY_AFTER_MAX_MILLISECONDS).optional(),
};

/** GET /orgs/{tenant}/computer/files: a directory listing with provenance. */
export const liveFileListingResponseSchema = z.object({
	...liveFileProvenanceShape,
	path: livePathSchema,
	truncated: z.boolean(),
	entries: z.array(liveFileEntrySchema).max(LIVE_FILE_LISTING_MAX_ENTRIES),
});

/** GET /orgs/{tenant}/computer/files/stat: one entry with provenance. */
export const liveFileStatResponseSchema = z.object({ ...liveFileProvenanceShape, entry: liveFileEntrySchema });

/** GET /orgs/{tenant}/computer/files/content: a byte range of one file with provenance. */
export const liveFileContentResponseSchema = z.object({
	...liveFileProvenanceShape,
	path: livePathSchema,
	size: z.number().int().nonnegative(),
	sha256: sha256Hex,
	encoding: z.enum(["utf8", "base64"]),
	binary: z.boolean(),
	offset: z.number().int().nonnegative(),
	length: z.number().int().nonnegative(),
	content: z.string(),
	truncated: z.boolean(),
	masked: z.boolean(),
	revealed: z.boolean(),
	editable: z.boolean(),
	modified_at: timestamp.nullable(),
	overlay: z.enum(["none", "pending", "conflict"]),
	mine_sha256: sha256Hex.nullable().optional(),
});

/** PUT /orgs/{tenant}/computer/files/content?path=  with If-Match: "<sha256>" or If-None-Match: *  */
export const liveFileWriteBodySchema = z.object({ content: liveFileTextSchema }).strict();

/** The answer to a save. */
export const liveFileWriteResponseSchema = z.object({
	source: z.enum(["live", "overlay"]),
	as_of: timestamp,
	path: livePathSchema,
	created: z.boolean(),
	size: z.number().int().nonnegative(),
	sha256: sha256Hex,
	previous_sha256: sha256Hex.nullable(),
	modified_at: timestamp,
	kept_as: livePathSchema.nullable(),
	/** false for a live edit (on the computer's disk, not yet in the saved copy); true for an overlay edit (already part of the saved copy as the next read sees it). */
	backed_up: z.boolean(),
});

/** POST /orgs/{tenant}/computer/files/reveal */
export const liveFileRevealBodySchema = z
	.object({
		path: livePathSchema,
		offset: z.number().int().min(0).optional(),
		length: z.number().int().min(1).max(LIVE_FILE_CONTENT_MAX_BYTES).optional(),
	})
	.strict();

/** POST /orgs/{tenant}/computer/files/overlay/discard: drop one pending overlay change of any kind (the revision is the entry's). */
export const liveFileDiscardBodySchema = z.object({ path: livePathSchema, revision: z.number().int().positive() }).strict();

/** POST /orgs/{tenant}/computer/files/move: rename a file, a symlink or a directory; header If-Match of the effective hash of `from` (L49). */
export const liveFileMoveBodySchema = z.object({ from: livePathSchema, to: livePathSchema }).strict();

/** POST /orgs/{tenant}/computer/files/directories: create a directory; idempotent. */
export const liveFileMkdirBodySchema = z.object({ path: livePathSchema }).strict();

/** DELETE /orgs/{tenant}/computer/files?path=&recursive=  with If-Match of the effective hash (L49). */
export const liveFileDeleteResponseSchema = z.object({
	source: z.enum(["live", "overlay"]),
	as_of: timestamp,
	path: livePathSchema,
	directory: z.boolean(),
	removed: z.number().int().nonnegative(),
	kept_as: livePathSchema.nullable(),
	backed_up: z.boolean(),
});

/** The answer to a rename. */
export const liveFileMoveResponseSchema = z.object({
	source: z.enum(["live", "overlay"]),
	as_of: timestamp,
	from: livePathSchema,
	to: livePathSchema,
	directory: z.boolean(),
	sha256: sha256Hex.nullable(),
	tree_sha256: sha256Hex.nullable(),
	backed_up: z.boolean(),
});

/** The answer to a directory creation. */
export const liveFileMkdirResponseSchema = z.object({
	source: z.enum(["live", "overlay"]),
	as_of: timestamp,
	path: livePathSchema,
	created: z.boolean(),
	backed_up: z.boolean(),
});

/** POST /orgs/{tenant}/computer/files/watch: the Files panel is open (true) or closed (false). */
export const liveFileWatchBodySchema = z.object({ open: z.boolean() }).strict();

/** The answer to a watch ping. */
export const liveFileWatchResponseSchema = z.object({
	state: z.enum(["off", "starting", "live"]),
	interactive_until: timestamp.nullable(),
	poll_interval_ms: z.number().int().min(250).max(60000).nullable(),
});

/** The body of every member-facing file refusal (Phase 1 shape, extended). */
export const liveFileErrorSchema = z.object({
	error: z.string(),
	message: z.string(),
	current_sha256: sha256Hex.nullable().optional(),
	retry_after_ms: z.number().int().positive().optional(),
	kept_as: livePathSchema.optional(),
});

/** A parsed file request. */
export type OwnerFileRequest = z.infer<typeof ownerFileRequestSchema>;
export type LiveFileOutcome = z.infer<typeof liveFileOutcomeSchema>;
export type OwnerFileResultRequest = z.infer<typeof ownerFileResultRequestSchema>;
export type LiveFileEntry = z.infer<typeof liveFileEntrySchema>;
export type LiveFileOwnerErrorCode = z.infer<typeof liveFileOwnerErrorCodeSchema>;
export type LiveFileFallbackReason = z.infer<typeof liveFileFallbackReasonSchema>;
export type LiveFileWriteResponse = z.infer<typeof liveFileWriteResponseSchema>;
