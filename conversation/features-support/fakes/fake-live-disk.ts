import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
	looksBinary,
	looksLikeSecretFile,
	livePathHasGitSegment,
	symlinkHashOf,
	treeHashOf,
	trimToCharacterBoundary,
	type LiveTreeDescendant,
} from "@chatticus/host-protocol/live-file-rules";
import {
	LIVE_FILE_CONTENT_MAX_BYTES,
	LIVE_FILE_READ_MAX_FILE_BYTES,
	LIVE_FILE_TREE_MAX_ENTRIES,
	type LiveFileEntry,
	type LiveFileOutcome,
	type LiveFileOwnerErrorCode,
	type OwnerFileRequest,
} from "@chatticus/host-protocol/live-files";

type DiskNode =
	| { readonly kind: "file"; content: Buffer; mode: string; modifiedAt: string }
	| { readonly kind: "symlink"; target: string }
	| { readonly kind: "directory" };

const WORKSPACE = "/workspace";
const MAX_LINK_HOPS = 8;
const DEFAULT_MODIFIED_AT = "2026-01-01T00:00:00.000Z";

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const EMPTY_TREE_HASH = sha256Of(new Uint8Array());

class DiskError extends Error {
	readonly code: LiveFileOwnerErrorCode;
	readonly currentSha256: string | undefined;

	constructor(code: LiveFileOwnerErrorCode, message: string, currentSha256?: string) {
		super(message);
		this.code = code;
		this.currentSha256 = currentSha256;
	}
}

/**
 * A stand-in for the disk of a running owner and for the file helper that works on it: it answers file requests the way
 * the contract (docs/LIVE_FILES_PROTOCOL.md section 8) says the helper does, in memory. Scenarios fill it with files, links
 * and anything "the bot" wrote, and the fake owner answers each request with `answer`.
 */
export class FakeLiveDisk {
	private readonly nodes = new Map<string, DiskNode>([[WORKSPACE, { kind: "directory" }]]);

	/** Create a file, and the directories above it. */
	putFile(path: string, content: Buffer | string): void {
		this.makeParents(path);
		this.nodes.set(path, { kind: "file", content: Buffer.from(content), mode: "664", modifiedAt: DEFAULT_MODIFIED_AT });
	}

	/** Create a link; a relative target is relative to the directory of the link. */
	putSymlink(path: string, target: string): void {
		this.makeParents(path);
		this.nodes.set(path, { kind: "symlink", target });
	}

	/** Create an empty directory, and the directories above it. */
	putDirectory(path: string): void {
		this.makeParents(path);
		if (!this.nodes.has(path)) this.nodes.set(path, { kind: "directory" });
	}

	/** The text of a file, or null when there is none. */
	textOf(path: string): string | null {
		const node = this.nodes.get(path);
		return node?.kind === "file" ? node.content.toString("utf8") : null;
	}

	/** The size of a file, or null when there is none. */
	sizeOf(path: string): number | null {
		const node = this.nodes.get(path);
		return node?.kind === "file" ? node.content.length : null;
	}

	/** Whether anything is at the path. */
	has(path: string): boolean {
		return this.nodes.has(path);
	}

	private makeParents(path: string): void {
		let directory = posix.dirname(path);
		const missing: string[] = [];
		while (directory !== "/" && !this.nodes.has(directory)) {
			missing.push(directory);
			directory = posix.dirname(directory);
		}
		for (const created of missing) this.nodes.set(created, { kind: "directory" });
	}

	private resolveFinal(path: string): { resolved: string; node: DiskNode | undefined } {
		let current = path;
		for (let hop = 0; hop <= MAX_LINK_HOPS; hop += 1) {
			const node = this.nodes.get(current);
			if (node?.kind !== "symlink") return { resolved: current, node };
			const target = posix.normalize(node.target.startsWith("/") ? node.target : posix.join(posix.dirname(current), node.target));
			if (target !== WORKSPACE && !target.startsWith(`${WORKSPACE}/`)) throw new DiskError("outside_workspace", "The link leads outside /workspace.");
			current = target;
		}
		throw new DiskError("io_error", "Too many links.");
	}

	private entryOf(path: string, node: DiskNode): LiveFileEntry {
		return {
			name: posix.basename(path),
			path: path as `/workspace/${string}`,
			kind: node.kind,
			size: node.kind === "file" ? node.content.length : null,
			mode: node.kind === "file" ? node.mode : node.kind === "directory" ? "775" : null,
			sha256: null,
			link_target: node.kind === "symlink" ? node.target : null,
			modified_at: node.kind === "file" ? node.modifiedAt : DEFAULT_MODIFIED_AT,
			overlay: "none",
			tree_sha256: null,
		};
	}

	private refuseGit(resolved: string): void {
		if (livePathHasGitSegment(resolved)) throw new DiskError("path_refused", "A .git path is refused.");
	}

	/**
	 * What the helper answers to one request.
	 *
	 * @param request The request as the poll delivered it.
	 * @returns The outcome the supervisor would post.
	 */
	answer(request: OwnerFileRequest): LiveFileOutcome {
		try {
			return this.run(request);
		} catch (error) {
			if (error instanceof DiskError) {
				return {
					status: "error",
					code: error.code,
					message: error.message,
					...(error.currentSha256 === undefined ? {} : { current_sha256: error.currentSha256 }),
				};
			}
			throw error;
		}
	}

	private run(request: OwnerFileRequest): LiveFileOutcome {
		switch (request.kind) {
			case "list":
				return this.list(request);
			case "stat":
				return this.stat(request);
			case "read":
				return this.read(request);
			case "write":
				return this.write(request);
			case "delete":
				return this.remove(request);
			case "move":
				return this.rename(request);
			case "mkdir":
				return this.makeDirectory(request);
		}
	}

	private list(request: Extract<OwnerFileRequest, { kind: "list" }>): LiveFileOutcome {
		const { resolved, node } = this.resolveFinal(request.path);
		this.refuseGit(resolved);
		if (node === undefined) throw new DiskError("not_found", "No such directory.");
		if (node.kind !== "directory") throw new DiskError("not_a_directory", "Not a directory.");
		const children = [...this.nodes.entries()]
			.filter(([path]) => path !== resolved && posix.dirname(path) === resolved)
			.sort(([leftPath, left], [rightPath, right]) => {
				const leftRank = left.kind === "directory" ? 0 : 1;
				const rightRank = right.kind === "directory" ? 0 : 1;
				if (leftRank !== rightRank) return leftRank - rightRank;
				const leftName = posix.basename(leftPath);
				const rightName = posix.basename(rightPath);
				return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
			});
		return {
			status: "ok",
			result: {
				kind: "list",
				resolved_path: resolved as `/workspace/${string}`,
				truncated: children.length > request.max_entries,
				entries: children.slice(0, request.max_entries).map(([path, child]) => this.entryOf(path, child)),
			},
		};
	}

	private stat(request: Extract<OwnerFileRequest, { kind: "stat" }>): LiveFileOutcome {
		this.refuseGit(request.path);
		const node = this.nodes.get(request.path);
		if (node === undefined) throw new DiskError("not_found", "No such path.");
		const entry = this.entryOf(request.path, node);
		if (node.kind === "symlink") entry.sha256 = symlinkHashOf(node.target, sha256Of);
		if (node.kind === "directory" && request.tree) entry.tree_sha256 = this.treeHashAt(request.path);
		return { status: "ok", result: { kind: "stat", entry } };
	}

	private descendantsOf(directory: string): Array<[string, DiskNode]> {
		return [...this.nodes.entries()].filter(([path]) => path.startsWith(`${directory}/`));
	}

	private treeHashAt(directory: string): string {
		const found = this.descendantsOf(directory);
		if (found.length > LIVE_FILE_TREE_MAX_ENTRIES) throw new DiskError("too_many_entries", "More than 5000 entries.");
		const descendants: LiveTreeDescendant[] = found.map(([path, node]) => {
			const relativePath = path.slice(directory.length + 1);
			if (node.kind === "file") return { relativePath, kind: "file", size: node.content.length };
			if (node.kind === "symlink") return { relativePath, kind: "symlink", target: node.target };
			return { relativePath, kind: "dir" };
		});
		return treeHashOf(descendants, sha256Of);
	}

	private leafHashOf(node: DiskNode): string {
		return node.kind === "symlink" ? symlinkHashOf(node.target, sha256Of) : sha256Of((node as { content: Buffer }).content);
	}

	private remove(request: Extract<OwnerFileRequest, { kind: "delete" }>): LiveFileOutcome {
		this.refuseGit(request.path);
		if (request.path === WORKSPACE) throw new DiskError("outside_workspace", "The workspace itself cannot be removed.");
		const node = this.nodes.get(request.path);
		if (node === undefined) throw new DiskError("not_found", "No such path.");
		const seenSha = request.precondition.type === "if_match" ? request.precondition.sha256 : undefined;
		const seenTree = request.precondition.type === "if_match_tree" ? request.precondition.tree_sha256 : undefined;
		const resolved = request.path as `/workspace/${string}`;
		if (request.recursive) {
			if (node.kind !== "directory") throw new DiskError("not_a_directory", "The path is not a folder.");
			const current = this.treeHashAt(request.path);
			if (seenTree !== current) throw new DiskError("precondition_failed", "The folder is not the one that was seen.", current);
			const removed = this.descendantsOf(request.path);
			for (const [path] of removed) this.nodes.delete(path);
			this.nodes.delete(request.path);
			return { status: "ok", result: { kind: "delete", resolved_path: resolved, directory: true, removed: removed.length + 1, sha256_before: null, tree_sha256_before: current } };
		}
		if (node.kind === "directory") {
			if (this.descendantsOf(request.path).length > 0) throw new DiskError("directory_not_empty", "The folder is not empty.");
			if (seenSha !== undefined || seenTree !== EMPTY_TREE_HASH) throw new DiskError("precondition_failed", "The folder is not the one that was seen.", EMPTY_TREE_HASH);
			this.nodes.delete(request.path);
			return { status: "ok", result: { kind: "delete", resolved_path: resolved, directory: true, removed: 1, sha256_before: null, tree_sha256_before: EMPTY_TREE_HASH } };
		}
		const current = this.leafHashOf(node);
		if (seenSha !== current || seenTree !== undefined) throw new DiskError("precondition_failed", "The path is not the one that was seen.", current);
		this.nodes.delete(request.path);
		return { status: "ok", result: { kind: "delete", resolved_path: resolved, directory: false, removed: 1, sha256_before: current, tree_sha256_before: null } };
	}

	private rename(request: Extract<OwnerFileRequest, { kind: "move" }>): LiveFileOutcome {
		this.refuseGit(request.path);
		this.refuseGit(request.to);
		if (request.path === WORKSPACE || request.to === WORKSPACE) throw new DiskError("invalid_move", "The workspace itself cannot be moved.");
		const node = this.nodes.get(request.path);
		if (node === undefined) throw new DiskError("not_found", "No such path.");
		if (request.to.startsWith(`${request.path}/`)) throw new DiskError("invalid_move", "A path cannot be moved into itself.");
		const parent = this.nodes.get(posix.dirname(request.to));
		if (parent === undefined) throw new DiskError("parent_missing", "The parent of the new path does not exist.");
		if (parent.kind !== "directory") throw new DiskError("not_a_directory", "The parent of the new path is not a folder.");
		const seenSha = request.precondition.type === "if_match" ? request.precondition.sha256 : undefined;
		const seenTree = request.precondition.type === "if_match_tree" ? request.precondition.tree_sha256 : undefined;
		const from = request.path as `/workspace/${string}`;
		const to = request.to as `/workspace/${string}`;
		if (node.kind === "directory") {
			const current = this.treeHashAt(request.path);
			if (seenTree !== current || seenSha !== undefined) throw new DiskError("precondition_failed", "The folder is not the one that was seen.", current);
			if (this.nodes.has(request.to)) throw new DiskError("already_exists", "Something with that name already exists.");
			const moved = this.descendantsOf(request.path);
			for (const [path] of moved) this.nodes.delete(path);
			this.nodes.delete(request.path);
			this.nodes.set(request.to, node);
			for (const [path, child] of moved) this.nodes.set(`${request.to}${path.slice(request.path.length)}`, child);
			return { status: "ok", result: { kind: "move", from, to, directory: true, sha256: null, tree_sha256: current } };
		}
		const current = this.leafHashOf(node);
		if (seenSha !== current || seenTree !== undefined) throw new DiskError("precondition_failed", "The path is not the one that was seen.", current);
		if (this.nodes.has(request.to)) throw new DiskError("already_exists", "Something with that name already exists.");
		this.nodes.delete(request.path);
		this.nodes.set(request.to, node);
		return { status: "ok", result: { kind: "move", from, to, directory: false, sha256: current, tree_sha256: null } };
	}

	private makeDirectory(request: Extract<OwnerFileRequest, { kind: "mkdir" }>): LiveFileOutcome {
		this.refuseGit(request.path);
		const resolved = request.path as `/workspace/${string}`;
		if (request.path === WORKSPACE) return { status: "ok", result: { kind: "mkdir", resolved_path: resolved, created: false } };
		const existing = this.nodes.get(request.path);
		if (existing?.kind === "directory") return { status: "ok", result: { kind: "mkdir", resolved_path: resolved, created: false } };
		if (existing !== undefined) throw new DiskError("already_exists", "A file or a link with that name already exists.");
		if (!this.nodes.has(posix.dirname(request.path))) throw new DiskError("parent_missing", "The parent directory does not exist.");
		this.nodes.set(request.path, { kind: "directory" });
		return { status: "ok", result: { kind: "mkdir", resolved_path: resolved, created: true } };
	}

	private read(request: Extract<OwnerFileRequest, { kind: "read" }>): LiveFileOutcome {
		const { resolved, node } = this.resolveFinal(request.path);
		this.refuseGit(resolved);
		if (node === undefined) throw new DiskError("not_found", "No such file.");
		if (node.kind !== "file") throw new DiskError("not_a_file", "Not a file.");
		if (node.content.length > LIVE_FILE_READ_MAX_FILE_BYTES) throw new DiskError("file_too_large", `The file is ${node.content.length} bytes.`);
		const sha256 = sha256Of(node.content);
		const base = { kind: "read" as const, resolved_path: resolved as `/workspace/${string}`, size: node.content.length, sha256, mode: node.mode, modified_at: node.modifiedAt };
		if (request.mask && (looksLikeSecretFile(resolved) || looksLikeSecretFile(request.path))) {
			return { status: "ok", result: { ...base, encoding: "utf8", binary: false, offset: request.offset, length: 0, content: "", truncated: false, masked: true } };
		}
		const binary = looksBinary(node.content);
		const requested = node.content.subarray(Math.min(request.offset, node.content.length), Math.min(request.offset + request.length, node.content.length));
		const slice = binary ? requested : trimToCharacterBoundary(requested);
		return {
			status: "ok",
			result: {
				...base,
				encoding: binary ? "base64" : "utf8",
				binary,
				offset: request.offset,
				length: slice.length,
				content: binary ? slice.toString("base64") : slice.toString("utf8"),
				truncated: Math.min(request.offset, node.content.length) + slice.length < node.content.length,
				masked: false,
			},
		};
	}

	private write(request: Extract<OwnerFileRequest, { kind: "write" }>): LiveFileOutcome {
		const { resolved, node } = this.resolveFinal(request.path);
		this.refuseGit(resolved);
		const bytes = Buffer.from(request.content, "utf8");
		if (bytes.length > LIVE_FILE_CONTENT_MAX_BYTES) throw new DiskError("file_too_large", "Content over 256 KiB.");
		if (request.precondition.type === "if_none_match") {
			if (node !== undefined) throw new DiskError("already_exists", "The file exists.");
			if (!this.nodes.has(posix.dirname(resolved))) throw new DiskError("parent_missing", "The folder does not exist.");
		} else {
			if (node === undefined) throw new DiskError("not_found", "No such file.");
			if (node.kind !== "file") throw new DiskError("not_a_file", "Not a file.");
			if (node.content.length > LIVE_FILE_CONTENT_MAX_BYTES) throw new DiskError("file_too_large", "The file is over 256 KiB.");
			const current = sha256Of(node.content);
			if (current !== request.precondition.sha256) throw new DiskError("precondition_failed", "The file changed.", current);
		}
		const before = node?.kind === "file" ? sha256Of(node.content) : null;
		this.nodes.set(resolved, { kind: "file", content: bytes, mode: node?.kind === "file" ? node.mode : "664", modifiedAt: DEFAULT_MODIFIED_AT });
		return {
			status: "ok",
			result: {
				kind: "write",
				resolved_path: resolved as `/workspace/${string}`,
				created: node === undefined,
				size: bytes.length,
				sha256_before: before,
				sha256_after: sha256Of(bytes),
				modified_at: DEFAULT_MODIFIED_AT,
			},
		};
	}
}
