import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const runbookPath = resolve(repositoryRoot, "docs", "OWNER_CREDENTIAL_REVOCATION.md");
const hostStartSource = readFileSync(resolve(repositoryRoot, "infra", "lib", "computer-host-start.ts"), "utf-8");
const environmentsSource = readFileSync(resolve(repositoryRoot, "infra", "lib", "environments.ts"), "utf-8");

describe("owner credential revocation runbook", () => {
	it("exists", () => {
		expect(existsSync(runbookPath)).toBe(true);
	});

	it("names the two broker-assumed roles and the signing key parameter that the infrastructure still defines", () => {
		const runbook = readFileSync(runbookPath, "utf-8");
		const names: Array<[string, string]> = [
			["ComputerSupervisorRole", hostStartSource],
			["ComputerOwnerScopedRole", hostStartSource],
		];
		for (const [name, infrastructureSource] of names) {
			expect(infrastructureSource, `${name} is no longer defined in infra/lib`).toContain(`"${name}"`);
			expect(runbook, `docs/OWNER_CREDENTIAL_REVOCATION.md must name ${name}`).toContain(name);
		}
		expect(environmentsSource, "the signing key parameter name is no longer defined in infra/lib").toContain("/model-gateway/signing-key");
		expect(runbook, "docs/OWNER_CREDENTIAL_REVOCATION.md must name the signing key parameter").toContain("/chatticus/development/model-gateway/signing-key");
	});

	it("is linked from the renewal contract and the threat model", () => {
		for (const file of ["OWNER_CREDENTIAL_RENEWAL.md", "THREAT_MODEL.md"]) {
			expect(readFileSync(resolve(repositoryRoot, "docs", file), "utf-8")).toContain("OWNER_CREDENTIAL_REVOCATION.md");
		}
	});
});
