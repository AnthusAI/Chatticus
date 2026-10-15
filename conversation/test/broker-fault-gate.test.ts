import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	NO_OWNER_BROKER_FAULTS,
	ownerBrokerFaultsFromEnvironment,
} from "../src/lambdas/owner-credential-broker-faults.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FAULT_VARIABLE = "CHATTICUS_OWNER_BROKER_FAULT";
const SECONDS_VARIABLE = "CHATTICUS_OWNER_BROKER_CREDENTIAL_SECONDS";
const ALLOWED_FILES = ["conversation/src/lambdas/owner-credential-broker-faults.ts", "infra/lib/control-plane-stack.ts"];

function sourceFilesUnder(directory: string): string[] {
	return readdirSync(directory).flatMap((entry) => {
		const path = join(directory, entry);
		if (entry === "node_modules" || entry === "cdk.out") return [];
		if (statSync(path).isDirectory()) return sourceFilesUnder(path);
		return /\.(ts|tsx|mts|js|mjs|json)$/.test(entry) ? [path] : [];
	});
}

function filesNaming(variable: string): string[] {
	return [join(repositoryRoot, "conversation", "src"), join(repositoryRoot, "infra", "lib")]
		.flatMap(sourceFilesUnder)
		.filter((path) => readFileSync(path, "utf-8").includes(variable))
		.map((path) => relative(repositoryRoot, path))
		.sort();
}

describe("the owner credential broker fault switch gate", () => {
	it.each([FAULT_VARIABLE, SECONDS_VARIABLE])("names %s only in the fault module and the stack's development branch", (variable) => {
		expect(filesNaming(variable).every((file) => ALLOWED_FILES.includes(file))).toBe(true);
		expect(filesNaming(variable)).toEqual(ALLOWED_FILES);
	});

	it("is imported by the broker handler, which reads no environment variable of the switch itself", () => {
		const brokerSource = readFileSync(join(repositoryRoot, "conversation", "src", "lambdas", "owner-credential-broker.ts"), "utf-8");
		expect(brokerSource).toContain('from "./owner-credential-broker-faults.ts"');
		expect(brokerSource).toContain("ownerBrokerFaultsFromEnvironment(environment)");
		expect(brokerSource).not.toContain("CHATTICUS_ENVIRONMENT");
	});

	it.each([
		["production", { CHATTICUS_ENVIRONMENT: "production" }],
		["staging", { CHATTICUS_ENVIRONMENT: "staging" }],
		["an empty environment", { CHATTICUS_ENVIRONMENT: "" }],
		["a missing environment", {}],
		["a near miss", { CHATTICUS_ENVIRONMENT: "Development" }],
	])("throws when the fault variable is set in %s", (_label, environment) => {
		expect(() => ownerBrokerFaultsFromEnvironment({ ...environment, [FAULT_VARIABLE]: "deny_supervisor_renewal" })).toThrow(/outside the development/);
	});

	it.each([
		["production", { CHATTICUS_ENVIRONMENT: "production" }],
		["a missing environment", {}],
	])("throws when only the credential seconds variable is set in %s", (_label, environment) => {
		expect(() => ownerBrokerFaultsFromEnvironment({ ...environment, [SECONDS_VARIABLE]: "900" })).toThrow(/outside the development/);
	});

	it("throws when a variable is set to an empty value outside development", () => {
		expect(() => ownerBrokerFaultsFromEnvironment({ CHATTICUS_ENVIRONMENT: "production", [FAULT_VARIABLE]: "" })).toThrow(/outside the development/);
	});

	it("does not throw and applies nothing when no variable is set, whatever the environment", () => {
		for (const environment of [{}, { CHATTICUS_ENVIRONMENT: "production" }, { CHATTICUS_ENVIRONMENT: "development" }]) {
			expect(ownerBrokerFaultsFromEnvironment(environment)).toBe(NO_OWNER_BROKER_FAULTS);
		}
	});

	it("reads each fault in development as a denial of one purpose", () => {
		const development = { CHATTICUS_ENVIRONMENT: "development" };
		expect([...ownerBrokerFaultsFromEnvironment({ ...development, [FAULT_VARIABLE]: "deny_supervisor_renewal" }).deniedPurposes]).toEqual(["supervisor_renewal"]);
		expect([...ownerBrokerFaultsFromEnvironment({ ...development, [FAULT_VARIABLE]: "deny_turn_renewal" }).deniedPurposes]).toEqual(["turn"]);
		expect(ownerBrokerFaultsFromEnvironment({ ...development, [FAULT_VARIABLE]: "none" }).deniedPurposes.size).toBe(0);
	});

	it("reads a credential duration from 900 to 3600 in development and refuses any other value", () => {
		const development = { CHATTICUS_ENVIRONMENT: "development" };
		expect(ownerBrokerFaultsFromEnvironment({ ...development, [SECONDS_VARIABLE]: "900" }).maximumCredentialSeconds).toBe(900);
		expect(ownerBrokerFaultsFromEnvironment({ ...development, [SECONDS_VARIABLE]: "3600" }).maximumCredentialSeconds).toBe(3600);
		for (const value of ["899", "3601", "7200", "-900", "900.5", "abc", "", "0x384"]) {
			expect(() => ownerBrokerFaultsFromEnvironment({ ...development, [SECONDS_VARIABLE]: value })).toThrow();
		}
	});

	it.each(["constructor", "toString", "deny_everything", "", "DENY_SUPERVISOR_RENEWAL"])("refuses the unknown fault %j in development", (fault) => {
		expect(() => ownerBrokerFaultsFromEnvironment({ CHATTICUS_ENVIRONMENT: "development", [FAULT_VARIABLE]: fault })).toThrow();
	});
});
