import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const repositoryRoot = new URL("../../", import.meta.url);

function portedFeaturePaths(): string[] {
	return readFileSync(new URL("features/ported-features.txt", repositoryRoot), "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"));
}

function behaveExcludePattern(): RegExp {
	const config = readFileSync(new URL("python/behave.ini", repositoryRoot), "utf8");
	const line = config.split("\n").find((candidate) => candidate.startsWith("exclude_re"));
	expect(line, "python/behave.ini must set exclude_re").toBeDefined();
	return new RegExp((line as string).split("=").slice(1).join("=").trim());
}

describe("ported-features manifest", () => {
	it("lists only feature files that exist", () => {
		for (const path of portedFeaturePaths()) {
			expect(existsSync(new URL(path, repositoryRoot)), path).toBe(true);
		}
	});

	it("is excluded from behave, and behave excludes nothing else", () => {
		const pattern = behaveExcludePattern();
		for (const path of portedFeaturePaths()) {
			expect(pattern.test(`/repo/${path}`), `${path} must be excluded from behave`).toBe(true);
		}
		expect(pattern.test("/repo/features/waitlist.feature")).toBe(false);
	});

	it("has no Python step file for a ported feature", () => {
		for (const path of portedFeaturePaths()) {
			const stem = path.replace(/^features\//, "").replace(/\.feature$/, "");
			expect(existsSync(new URL(`features/steps/${stem}_steps.py`, repositoryRoot)), stem).toBe(false);
		}
	});

	it("has every path begin with features/ and end with .feature", () => {
		for (const path of portedFeaturePaths()) {
			expect(path).toMatch(/^features\/.*\.feature$/);
		}
	});
});
