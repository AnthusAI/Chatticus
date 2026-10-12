/** The root of every path a person or the Front Door names. */
export const LIVE_WORKSPACE_ROOT = "/workspace";

/** The longest path, in characters, any file route accepts. */
export const LIVE_FILE_PATH_MAX_CHARACTERS = 1024;

const BINARY_SNIFF_BYTES = 8192;

const SECRET_NAME_PATTERNS: readonly RegExp[] = [
	/^\.env$/,
	/^\.env\..+$/,
	/\.pem$/,
	/\.key$/,
	/^id_rsa/,
	/^id_ed25519/,
	/^credentials$/,
	/^\.netrc$/,
	/^\.npmrc$/,
	/^\.git-credentials$/,
	/\.p12$/,
	/\.pfx$/,
];

const SECRET_DIRECTORY_NAMES: ReadonlySet<string> = new Set([".ssh", ".aws"]);

/** Why a path is not a workspace path. */
export type LivePathProblem = "empty" | "too_long" | "nul" | "not_absolute" | "dot_dot" | "outside_workspace";

function normalizedSegmentsOf(raw: string): string[] {
	return raw.split("/").filter((segment) => segment !== "" && segment !== ".");
}

/**
 * Why a path is not a workspace path, or null when it is one. Lexical only: it follows no link.
 * The path must be absolute, at most 1024 characters, hold no NUL and no ".." segment, and after
 * normalisation be "/workspace" or start with "/workspace/".
 */
export function livePathProblem(raw: string): LivePathProblem | null {
	if (raw === "") return "empty";
	if (raw.length > LIVE_FILE_PATH_MAX_CHARACTERS) return "too_long";
	if (raw.includes("\u0000")) return "nul";
	if (!raw.startsWith("/")) return "not_absolute";
	if (raw.split("/").includes("..")) return "dot_dot";
	const normalized = `/${normalizedSegmentsOf(raw).join("/")}`;
	if (normalized !== LIVE_WORKSPACE_ROOT && !normalized.startsWith(`${LIVE_WORKSPACE_ROOT}/`)) return "outside_workspace";
	return null;
}

/** The normalised form ("/workspace/a/b", no trailing slash, no "." segment). Precondition: livePathProblem(raw) === null. */
export function normalizeLivePath(raw: string): string {
	return `/${normalizedSegmentsOf(raw).join("/")}`;
}

/** Whether any segment of a normalised path is exactly ".git" (a file or a directory). */
export function livePathHasGitSegment(normalized: string): boolean {
	return normalized.split("/").includes(".git");
}

/**
 * Whether a path looks like it holds a secret. Case-insensitive on the segments. True for a file named .env or .env.*,
 * *.pem, *.key, *.p12, *.pfx, id_rsa*, id_ed25519*, credentials, .netrc, .npmrc, .git-credentials, and for any file under
 * a directory named .ssh or .aws. It is the Phase 1 list plus .git-credentials.
 */
export function looksLikeSecretFile(path: string): boolean {
	const segments = path.toLowerCase().split("/");
	const name = segments.at(-1) ?? "";
	if (segments.slice(0, -1).some((segment) => SECRET_DIRECTORY_NAMES.has(segment))) return true;
	return SECRET_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

/** True when the first 8 KiB holds a NUL or is not valid UTF-8. */
export function looksBinary(bytes: Uint8Array): boolean {
	const head = bytes.subarray(0, BINARY_SNIFF_BYTES);
	if (head.includes(0)) return true;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: bytes.length > BINARY_SNIFF_BYTES });
		return false;
	} catch {
		return true;
	}
}

/** Drop an incomplete UTF-8 sequence from the end of a byte range. */
export function trimToCharacterBoundary<BytesType extends Uint8Array>(bytes: BytesType): BytesType {
	let end = bytes.length;
	for (let back = 1; back <= 3 && back <= bytes.length; back += 1) {
		const byte = bytes[bytes.length - back]!;
		if ((byte & 0xc0) === 0x80) continue;
		const expected = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
		if (expected > back) end = bytes.length - back;
		break;
	}
	return bytes.subarray(0, end) as BytesType;
}

/** The number of bytes of the UTF-8 encoding of a string. */
export function utf8ByteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

/** One descendant of a directory in the effective view, as the tree hash of 7.8.2 sees it. The path is relative to the directory. */
export type LiveTreeDescendant =
	| { relativePath: string; kind: "file"; size: number }
	| { relativePath: string; kind: "symlink"; target: string }
	| { relativePath: string; kind: "dir" };

/** A function that returns the lowercase hexadecimal SHA-256 of bytes; the caller supplies it so this module imports nothing. */
export type Sha256HexFunction = (bytes: Uint8Array) => string;

/** The bytes whose SHA-256 is the effective hash of a symlink: the text "symlink", a NUL byte, then the target. */
export function symlinkHashInputOf(target: string): Uint8Array {
	return new TextEncoder().encode(`symlink\u0000${target}`);
}

/** The effective hash of a symlink (L49). */
export function symlinkHashOf(target: string, sha256Hex: Sha256HexFunction): string {
	return sha256Hex(symlinkHashInputOf(target));
}

function compareUtf8Bytes(left: Uint8Array, right: Uint8Array): number {
	const shared = Math.min(left.length, right.length);
	for (let index = 0; index < shared; index += 1) {
		const difference = left[index]! - right[index]!;
		if (difference !== 0) return difference;
	}
	return left.length - right.length;
}

/**
 * The bytes whose SHA-256 is the tree hash of a directory (7.8.2): one line `kind NUL relative-path NUL value LF` per
 * descendant, sorted by relative path as UTF-8 bytes, where value is the size of a file, the target of a symlink, or 0.
 * An empty directory yields no bytes.
 */
export function treeHashInputOf(descendants: readonly LiveTreeDescendant[]): Uint8Array {
	const encoder = new TextEncoder();
	const keyed = descendants.map((descendant) => ({ descendant, key: encoder.encode(descendant.relativePath) }));
	keyed.sort((left, right) => compareUtf8Bytes(left.key, right.key));
	const lines = keyed.map(({ descendant }) => {
		const value = descendant.kind === "file" ? String(descendant.size) : descendant.kind === "symlink" ? descendant.target : "0";
		return `${descendant.kind}\u0000${descendant.relativePath}\u0000${value}\n`;
	});
	return encoder.encode(lines.join(""));
}

/** The tree hash of a directory (L49): the SHA-256 of {@link treeHashInputOf}. */
export function treeHashOf(descendants: readonly LiveTreeDescendant[], sha256Hex: Sha256HexFunction): string {
	return sha256Hex(treeHashInputOf(descendants));
}
