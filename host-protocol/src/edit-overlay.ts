import { z } from "zod";
import { livePathSchema } from "./live-files.ts";

/** The version of the index object. */
export const OVERLAY_INDEX_VERSION = 1;
/** The most entries of any kind an overlay holds. */
export const OVERLAY_MAX_ENTRIES = 100;
/** The most blob content, from puts, an overlay holds. */
export const OVERLAY_MAX_TOTAL_BYTES = 8388608;
/** The largest serialized index. */
export const OVERLAY_INDEX_MAX_BYTES = 262144;
/** How many times the Front Door re-reads and re-judges after a lost index swap. */
export const OVERLAY_CAS_ATTEMPTS = 3;
/** The supervisor's time budget to apply a sealed set. */
export const OVERLAY_APPLY_BUDGET_SECONDS = 30;
/** The `retry_after_ms` of `computer_starting`. */
export const OVERLAY_SEAL_RETRY_AFTER_MILLISECONDS = 2000;
/** The `retry_after_ms` of `computer_stopping`. */
export const OVERLAY_STOPPING_RETRY_AFTER_MILLISECONDS = 5000;
/** How often the supervisor retries a lost clear. */
export const OVERLAY_CLEAR_RETRY_SECONDS = 10;
/** The publish check delay after an apply. */
export const OVERLAY_EARLY_PUBLISH_SECONDS = 5;
/** The key, under a computer's snapshot prefix, of the overlay index. */
export const OVERLAY_INDEX_OBJECT = "overlay/index.json";
/** The key, under a computer's snapshot prefix, of the blob with this content hash. */
export const overlayBlobObject = (sha256: string): string => `overlay/blobs/${sha256}`;

const identifier = z.string().min(1).max(256);
const timestamp = z.iso.datetime();
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/** A conflict: the disk held something else than the change expected. Derived conflicts (the snapshot moved) are not stored. */
export const overlayConflictSchema = z
	.object({
		reason: z.enum(["changed", "collision", "not_empty", "kind_mismatch"]),
		disk_sha256: sha256Hex.nullable(),
		found_at: timestamp,
	})
	.strict();

const entryBase = {
	path: livePathSchema,
	edited_by: identifier,
	edited_at: timestamp,
	revision: z.number().int().positive(),
	conflict: overlayConflictSchema.nullable(),
};
const mode = z.string().regex(/^[0-7]{3,4}$/);

/** One pending change. One path has at most one entry. The content of a `put` is the blob named by `sha256`; the other kinds carry no blob. */
export const overlayEntrySchema = z.discriminatedUnion("op", [
	z
		.object({
			...entryBase,
			op: z.literal("put"),
			sha256: sha256Hex,
			size: z.number().int().nonnegative().max(262144),
			mode,
			base_sha256: sha256Hex.nullable(),
			/** The file this put was renamed from (hidden, and deleted at apply with `from_sha256`); null for a plain create or replace. */
			from: livePathSchema.nullable(),
			from_sha256: sha256Hex.nullable(),
		})
		.strict(),
	z
		.object({
			...entryBase,
			op: z.literal("delete"),
			directory: z.boolean(),
			recursive: z.boolean(),
			/** The effective hash seen: a file's content hash or a symlink's hash (L49); null for a directory. */
			base_sha256: sha256Hex.nullable(),
			/** The tree hash seen, for a directory. */
			tree_sha256: sha256Hex.nullable(),
		})
		.strict(),
	z.object({ ...entryBase, op: z.literal("mkdir"), mode }).strict(),
	z
		.object({
			...entryBase,
			op: z.literal("move"),
			from: livePathSchema,
			directory: z.boolean(),
			/** The kept content hash of a moved file or symlink; null for a directory. */
			sha256: sha256Hex.nullable(),
			/** The tree hash of a moved directory. */
			tree_sha256: sha256Hex.nullable(),
			size: z.number().int().nonnegative(),
			mode,
		})
		.strict(),
]);

/** Who may write the index: nobody but the Front Door; and not at all while a valid seal exists. */
export const overlaySealSchema = z
	.object({ owner_id: identifier, generation: z.number().int().positive(), sealed_at: timestamp, snapshot_generation: z.number().int().nonnegative() })
	.strict();

/** The object `overlay/index.json`. Paths are unique; the contents add up to at most 8 MiB. */
export const overlayIndexSchema = z
	.object({
		version: z.literal(OVERLAY_INDEX_VERSION),
		sealed: overlaySealSchema.nullable(),
		entries: z.array(overlayEntrySchema).max(OVERLAY_MAX_ENTRIES),
	})
	.strict()
	.refine((index) => new Set(index.entries.map((entry) => entry.path)).size === index.entries.length, { message: "paths are unique" })
	.refine(
		(index) => {
			const sources = index.entries.flatMap((entry) => (("from" in entry && entry.from !== null) ? [entry.from] : []));
			return new Set(sources).size === sources.length && sources.every((source) => !index.entries.some((entry) => entry.path === source));
		},
		{ message: "a source path is moved once and is not also an entry" },
	)
	.refine(
		(index) => index.entries.reduce((total, entry) => total + (entry.op === "put" ? entry.size : 0), 0) <= OVERLAY_MAX_TOTAL_BYTES,
		{ message: "content over 8 MiB" },
	);

/** POST /orgs/{tenant}/host/owner/overlay-seal: after extraction, close the overlay to member writes and get the entries to apply. */
export const ownerOverlaySealRequestSchema = z.object({ owner_id: identifier, generation: z.number().int().positive() }).strict();
/** The entries the owner must apply. */
export const ownerOverlaySealResponseSchema = z.object({ entries: z.array(overlayEntrySchema).max(OVERLAY_MAX_ENTRIES) });

const entryReference = z.object({ path: livePathSchema, revision: z.number().int().positive() }).strict();

/**
 * POST /orgs/{tenant}/host/owner/overlay-applied: after a publish that began after the apply, clear exactly these entries;
 * and/or report entries that were not applied because the disk held a third version.
 */
export const ownerOverlayAppliedRequestSchema = z
	.object({
		owner_id: identifier,
		generation: z.number().int().positive(),
		cleared: z.array(entryReference).max(OVERLAY_MAX_ENTRIES).default([]),
		conflicts: z.array(entryReference.extend({ disk_sha256: sha256Hex.nullable() })).max(OVERLAY_MAX_ENTRIES).default([]),
	})
	.strict();
/** How many entries remain after the clear. */
export const ownerOverlayAppliedResponseSchema = z.object({ remaining: z.number().int().nonnegative() });

/** A parsed overlay index. */
export type OverlayIndex = z.infer<typeof overlayIndexSchema>;
/** A parsed overlay entry. */
export type OverlayEntry = z.infer<typeof overlayEntrySchema>;
