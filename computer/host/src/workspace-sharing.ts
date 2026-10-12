import { realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** The group that owns the workspace so the owner and the unprivileged shell can both write it. */
export const WORKSPACE_SHARING_GROUP = "chatticus-workspace";

/**
 * Give the workspace to the group both the owner and the unprivileged shell belong to: every file and directory is
 * group-owned and group-writable, and directories pass the group on to what is created in them.
 *
 * @param workspaceRoot The workspace directory, or a link to it.
 * @param group The group name.
 */
export async function shareWorkspaceWithShell(workspaceRoot: string, group: string = WORKSPACE_SHARING_GROUP): Promise<void> {
	const real = realpathSync(workspaceRoot);
	await promisify(execFile)("sh", [
		"-c",
		'chgrp -R "$1" "$2" && chmod -R g+rwX "$2" && find "$2" -type d -exec chmod g+s {} +',
		"sh",
		group,
		real,
	]);
}
