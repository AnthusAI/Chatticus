/**
 * An argument the host cannot accept, such as a workspace path that escapes the workspace tree. Python raised the
 * built-in `ValueError` for these; the host keeps the name.
 */
export class ValueError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ValueError";
	}
}

const WORKSPACE_ROOT_PREFIX = "/workspace/";
const WORKSPACE_RELATIVE_PREFIX = "workspace/";

/** Quote text the way the Python port quoted it in messages, so messages stay the same. */
export function pythonRepr(text: string): string {
	const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
	const escaped = text.replaceAll("\\", "\\\\").replaceAll(quote, `\\${quote}`);
	return `${quote}${escaped}${quote}`;
}

function pathParts(normalized: string): string[] {
	return normalized.split("/").filter((part) => part !== "" && part !== ".");
}

function stripLeadingSlashes(text: string): string {
	return text.replace(/^\/+/, "");
}

/**
 * Return the path under the host `workspace/` tree for one model path.
 *
 * Model tools use absolute-style paths such as `/workspace/research/notes.txt`. The host disk stores
 * `research/notes.txt` under its `workspace` directory.
 *
 * @param modelPath The path the model named.
 * @returns The path relative to the host workspace directory.
 * @throws ValueError If the path is empty or escapes the workspace tree.
 */
export function workspaceRelativePath(modelPath: string): string {
	const normalized = modelPath.trim().replaceAll("\\", "/");
	if (normalized === "") {
		throw new ValueError("workspace path is required");
	}
	if (pathParts(normalized).includes("..")) {
		throw new ValueError(`Path ${pythonRepr(modelPath)} escapes the workspace tree.`);
	}
	let relative: string;
	if (normalized.startsWith(WORKSPACE_ROOT_PREFIX)) {
		relative = stripLeadingSlashes(normalized.slice(WORKSPACE_ROOT_PREFIX.length));
	} else if (normalized.startsWith(WORKSPACE_RELATIVE_PREFIX)) {
		relative = stripLeadingSlashes(normalized.slice(WORKSPACE_RELATIVE_PREFIX.length));
	} else {
		relative = stripLeadingSlashes(normalized);
	}
	if (relative === "" || relative.startsWith("..")) {
		throw new ValueError(`Path ${pythonRepr(modelPath)} escapes the workspace tree.`);
	}
	return relative;
}

/**
 * Return the relative directory under the host `workspace/` tree for one working directory.
 *
 * Model tools use `/workspace` or `/workspace/research` as working directories.
 *
 * @param modelCwd The working directory the model named.
 * @returns The directory relative to the host workspace directory, empty for the workspace root.
 * @throws ValueError If the directory is empty or escapes the workspace tree.
 */
export function workspaceCwdRelative(modelCwd: string): string {
	const normalized = modelCwd.trim().replaceAll("\\", "/").replace(/\/+$/, "");
	if (normalized === "") {
		throw new ValueError("workspace cwd is required");
	}
	if (normalized === "/workspace" || normalized === "workspace") {
		return "";
	}
	return workspaceRelativePath(modelCwd);
}
