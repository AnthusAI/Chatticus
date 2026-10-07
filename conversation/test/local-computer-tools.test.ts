import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	boundedTerminalOutput,
	createScrubbedBashTool,
	MAXIMUM_TERMINAL_OUTPUT_CHARACTERS,
	resolveWorkspacePath,
	scrubbedShellEnvironment,
} from "../src/pi/local-computer-tools.ts";

describe("scrubbedShellEnvironment", () => {
	it("holds exactly a path, a home, a locale and a terminal type", () => {
		const environment = scrubbedShellEnvironment("/workspace", { PATH: "/usr/bin", OPENAI_API_KEY: "secret" });
		expect(environment).toEqual({ PATH: "/usr/bin", HOME: "/workspace", LANG: "C.UTF-8", TERM: "dumb" });
	});

	it("falls back to a standard search path when the owner has none", () => {
		expect(scrubbedShellEnvironment("/workspace", {}).PATH).toContain("/usr/bin");
	});
});

describe("resolveWorkspacePath", () => {
	it("maps absolute and relative paths under the workspace to the real directory", () => {
		expect(resolveWorkspacePath("/real", "/workspace", "/workspace/a/b.txt")).toBe("/real/a/b.txt");
		expect(resolveWorkspacePath("/real", "/workspace", "a/b.txt")).toBe("/real/a/b.txt");
		expect(resolveWorkspacePath("/real", "/workspace", "/workspace")).toBe("/real");
	});

	it("refuses a path that leaves the workspace, by prefix or by traversal", () => {
		expect(() => resolveWorkspacePath("/real", "/workspace", "/etc/passwd")).toThrow("outside the workspace");
		expect(() => resolveWorkspacePath("/real", "/workspace", "/workspace/../etc")).toThrow("outside the workspace");
		expect(() => resolveWorkspacePath("/real", "/workspace", "/workspace-other/file")).toThrow("outside the workspace");
	});
});

describe("boundedTerminalOutput", () => {
	it("leaves short output as it is and says so when it keeps only the end of long output", () => {
		expect(boundedTerminalOutput("short")).toBe("short");
		const long = `${"x".repeat(MAXIMUM_TERMINAL_OUTPUT_CHARACTERS)}tail`;
		const bounded = boundedTerminalOutput(long);
		expect(bounded.startsWith("[output truncated: showing the last")).toBe(true);
		expect(bounded.endsWith("tail")).toBe(true);
	});
});

describe("the scrubbed bash tool", () => {
	let directory = "";
	const saved = new Map<string, string | undefined>();

	beforeEach(() => {
		directory = realpathSync(mkdtempSync(join(tmpdir(), "local-bash-")));
		for (const name of ["OPENAI_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) {
			saved.set(name, process.env[name]);
			process.env[name] = `owner-secret-${name}`;
		}
	});

	afterEach(() => {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(directory, { recursive: true, force: true });
	});

	it("runs a command that prints its environment without any variable of the owner", async () => {
		let output = "";
		const api = { env: new NodeExecutionEnv({ cwd: directory }), output: (chunk: string) => (output += chunk), diagnostic: () => undefined };
		await createScrubbedBashTool(directory, directory).execute({ command: "env" } as never, api as never, BACKGROUND_CONTEXT);
		expect(output).not.toContain("owner-secret");
		expect(output).not.toContain("OPENAI_API_KEY");
		expect(output).not.toContain("AWS_");
		expect(output).toContain(`HOME=${directory}`);
		expect(output).toContain("TERM=dumb");
		const names = output.split("\n").filter((line) => line.includes("=")).map((line) => line.split("=")[0]);
		for (const name of names) expect(["PATH", "HOME", "LANG", "TERM", "PWD", "SHLVL", "_", "OLDPWD"]).toContain(name);
	});

	it("starts the command in the directory it was given", async () => {
		let output = "";
		const api = { env: new NodeExecutionEnv({ cwd: directory }), output: (chunk: string) => (output += chunk), diagnostic: () => undefined };
		await createScrubbedBashTool(directory, directory).execute({ command: "pwd" } as never, api as never, BACKGROUND_CONTEXT);
		expect(output.trim()).toBe(directory);
	});
});
