import { describe, expect, it } from "vitest";
import { canonicalQueryString } from "../src/acceptance/sigv4.ts";
import {
	integrationTestEnabledFromEnvironment,
	integrationTestHmacSecret,
	loadIntegrationTestAuthConfig,
	parseIntegrationTestToken,
} from "../src/auth/integration-test.ts";
import { operatorKeyConfigured, parseOperatorBearer, verifyOperatorBearer } from "../src/auth/operator.ts";
import { hashWorkerToken, mintWorkerToken, verifyWorkerTokenHash } from "../src/auth/worker-credentials.ts";

describe("operator credentials", () => {
	it("treats a blank key as unconfigured and refuses every token", () => {
		expect(operatorKeyConfigured("   ")).toBe(false);
		expect(verifyOperatorBearer("", "")).toBe(false);
		expect(verifyOperatorBearer("anything", "  ")).toBe(false);
	});

	it("compares against the trimmed key and rejects different lengths", () => {
		expect(verifyOperatorBearer("secret", " secret ")).toBe(true);
		expect(verifyOperatorBearer("secre", "secret")).toBe(false);
		expect(verifyOperatorBearer("secreT", "secret")).toBe(false);
	});

	it("parses only the bearer scheme", () => {
		expect(parseOperatorBearer("Bearer abc")).toBe("abc");
		expect(parseOperatorBearer("Basic abc")).toBeNull();
		expect(parseOperatorBearer(null)).toBeNull();
	});
});

describe("worker credentials", () => {
	it("hashes to SHA-256 hex and verifies the minted token", () => {
		const token = mintWorkerToken();
		expect(token.length).toBeGreaterThanOrEqual(32);
		expect(hashWorkerToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
		expect(verifyWorkerTokenHash(token, hashWorkerToken(token))).toBe(true);
		expect(verifyWorkerTokenHash(token, hashWorkerToken("other"))).toBe(false);
	});
});

describe("integration test configuration", () => {
	it("is enabled only by the exact string true", () => {
		expect(integrationTestEnabledFromEnvironment({ CHATTICUS_INTEGRATION_TEST_ENABLED: "true" })).toBe(true);
		expect(integrationTestEnabledFromEnvironment({ CHATTICUS_INTEGRATION_TEST_ENABLED: "1" })).toBe(false);
		expect(integrationTestEnabledFromEnvironment({})).toBe(false);
	});

	it("is never loaded for production and needs an allowed role", async () => {
		const base = { invokeKey: "key", allowedRoleArn: "arn:role", enabled: true, environmentVariables: {} };
		expect(await loadIntegrationTestAuthConfig({ ...base, environment: "production" })).toBeNull();
		expect(await loadIntegrationTestAuthConfig({ ...base, environment: "development", allowedRoleArn: "" })).toBeNull();
		expect(await loadIntegrationTestAuthConfig({ ...base, environment: "development", enabled: false })).toBeNull();
		const config = await loadIntegrationTestAuthConfig({ ...base, environment: "development" });
		expect(config?.tenantId).toBe("integration-test");
		expect(config?.userId).toBe("integration-test-runner");
		expect(config?.hmacSecret.equals(integrationTestHmacSecret("key"))).toBe(true);
	});

	it("falls back from the environment to the parameter reader", async () => {
		const names: string[] = [];
		const config = await loadIntegrationTestAuthConfig({
			environment: "staging",
			invokeKey: "key",
			enabled: true,
			environmentVariables: { CHATTICUS_INTEGRATION_TEST_TENANT_ID: "from-environment" },
			readParameter: async (name) => {
				names.push(name);
				return name.endsWith("allowed-role-arn") ? "arn:from-parameter" : "";
			},
		});
		expect(config?.allowedRoleArn).toBe("arn:from-parameter");
		expect(config?.tenantId).toBe("from-environment");
		expect(names).toContain("/chatticus/staging/integration-test/allowed-role-arn");
	});

	it("splits a token on its last dot", () => {
		expect(parseIntegrationTestToken("a.b.c")).toEqual(["a.b", "c"]);
		expect(parseIntegrationTestToken("nodot")).toBeNull();
	});
});

describe("canonicalQueryString", () => {
	it("sorts keys and percent-encodes reserved characters", () => {
		expect(canonicalQueryString({ b: "x y", a: "1/2", c: "(!)" })).toBe("a=1%2F2&b=x%20y&c=%28%21%29");
	});
});
