import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("cucumber-js --dry-run gate", () => {
	it("verifies all features have defined and unambiguous steps", () => {
		const output = execSync("npx cucumber-js --dry-run --format summary", {
			cwd: new URL("..", import.meta.url).pathname,
			encoding: "utf8",
		});

		expect(output).not.toContain("undefined");
		expect(output).not.toContain("ambiguous");
	});
});
