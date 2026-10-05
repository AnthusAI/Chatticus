import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { ChatticusWorld } from "./world.ts";

const execFileAsync = promisify(execFile);

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const webDirectory = join(repositoryRoot, "web");
const harnessPath = join(webDirectory, "test-support", "membership-ui-harness.ts");
const tsxPath = join(repositoryRoot, "node_modules", ".bin", "tsx");

/**
 * Run one command of the web SPA membership UI harness against the scenario's
 * own state file and return the harness state it prints.
 */
export async function runMembershipUiHarness(
	world: ChatticusWorld,
	command: string,
	payload?: Record<string, unknown>,
): Promise<Record<string, any>> {
	if (world.snapshotTmpdir === null) {
		throw new Error("The scenario temporary directory is not available.");
	}
	const args = [harnessPath, command];
	if (payload !== undefined) {
		args.push(JSON.stringify(payload));
	}
	const { stdout } = await execFileAsync(tsxPath, args, {
		cwd: webDirectory,
		env: {
			...process.env,
			CHATTICUS_MEMBERSHIP_UI_HARNESS_STATE: join(world.snapshotTmpdir, "membership-ui-harness-state.json"),
		},
	});
	const state = JSON.parse(stdout) as Record<string, any>;
	world.membershipUiHarness = state;
	return state;
}
