import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const webDirectory = join(repositoryRoot, "web");
const tsxPath = join(repositoryRoot, "node_modules", ".bin", "tsx");

/**
 * Run one tsx harness from web/test-support, printing JSON on stdout, and
 * return the parsed output. The harness imports production web code.
 */
export async function runWebHarness(
	harnessFileName: string,
	args: string[],
	env: Record<string, string> = {},
): Promise<Record<string, any>> {
	const harnessPath = join(webDirectory, "test-support", harnessFileName);
	try {
		const { stdout } = await execFileAsync(tsxPath, [harnessPath, ...args], {
			cwd: webDirectory,
			env: { ...process.env, ...env },
			timeout: 60_000,
		});
		return JSON.parse(stdout) as Record<string, any>;
	} catch (error) {
		const failure = error as { stderr?: string; stdout?: string; message: string };
		throw new Error(`web harness ${harnessFileName} failed: ${failure.stderr || failure.stdout || failure.message}`);
	}
}
