import { afterEach, describe, expect, it, vi } from "vitest";
import { relayStsGetCallerIdentityArn } from "../src/auth/integration-test.ts";

const ARN = "arn:aws:sts::123456789012:assumed-role/runner/session";
const STS_XML = `<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>${ARN}</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>`;
const SECRET_AUTHORIZATION =
	"AWS4-HMAC-SHA256 Credential=AKIDDISTINCTFAKE/20261006/us-east-1/sts/aws4_request, Signature=deadbeefdistinctsignature";
const SECRET_TOKEN = "FwoDistinctFakeSessionTokenValue123";

function signedRequest(withAuthorization: boolean): Request {
	const headers: Record<string, string> = {
		host: "abc123.lambda-url.us-east-1.on.aws",
		"x-amz-date": "20261006T170715Z",
		"x-amz-security-token": SECRET_TOKEN,
	};
	if (withAuthorization) {
		headers["authorization"] = SECRET_AUTHORIZATION;
	}
	return new Request("https://abc123.lambda-url.us-east-1.on.aws/integration-test/session", { method: "POST", headers });
}

function captureLogs(): string[] {
	const logged: string[] = [];
	const capture = (...parts: unknown[]) => {
		logged.push(parts.map(String).join(" "));
	};
	vi.spyOn(console, "warn").mockImplementation(capture);
	vi.spyOn(console, "log").mockImplementation(capture);
	vi.spyOn(console, "error").mockImplementation(capture);
	return logged;
}

function expectNoSecrets(logged: string[]): void {
	const everything = logged.join("\n");
	expect(everything).not.toContain(SECRET_AUTHORIZATION);
	expect(everything).not.toContain("deadbeefdistinctsignature");
	expect(everything).not.toContain("AKIDDISTINCTFAKE");
	expect(everything).not.toContain(SECRET_TOKEN);
	expect(everything).not.toContain("20261006T170715Z");
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("relayStsGetCallerIdentityArn failure diagnostics", () => {
	it("names the missing authorization header", async () => {
		const logged = captureLogs();
		expect(await relayStsGetCallerIdentityArn(signedRequest(false))).toBeNull();
		expect(logged).toHaveLength(1);
		expect(JSON.parse(logged[0] as string)).toEqual({
			event: "sts_relay_failed",
			reason: "no_authorization_header",
			forwardedHeaderNames: ["x-amz-date", "x-amz-security-token"],
		});
		expectNoSecrets(logged);
	});

	it("reports a failed fetch with the error name and message", async () => {
		const logged = captureLogs();
		vi.stubGlobal("fetch", async () => {
			throw Object.assign(new Error("getaddrinfo ENOTFOUND sts.amazonaws.com"), { name: "TypeError" });
		});
		expect(await relayStsGetCallerIdentityArn(signedRequest(true))).toBeNull();
		expect(logged).toHaveLength(1);
		expect(JSON.parse(logged[0] as string)).toEqual({
			event: "sts_relay_failed",
			reason: "fetch_failed",
			forwardedHeaderNames: ["authorization", "x-amz-date", "x-amz-security-token"],
			errorName: "TypeError",
			errorMessage: "getaddrinfo ENOTFOUND sts.amazonaws.com",
		});
		expectNoSecrets(logged);
	});

	it("reports a non-200 with the status and the first 300 characters of the body", async () => {
		const logged = captureLogs();
		const body = `<ErrorResponse><Code>SignatureDoesNotMatch</Code>${"x".repeat(400)}</ErrorResponse>`;
		vi.stubGlobal("fetch", async () => new Response(body, { status: 403 }));
		expect(await relayStsGetCallerIdentityArn(signedRequest(true))).toBeNull();
		expect(logged).toHaveLength(1);
		const payload = JSON.parse(logged[0] as string);
		expect(payload).toMatchObject({ event: "sts_relay_failed", reason: "non_200", status: 403 });
		expect(payload.bodySnippet).toBe(body.slice(0, 300));
		expect(payload.bodySnippet).toContain("SignatureDoesNotMatch");
		expectNoSecrets(logged);
	});

	it("reports a 200 response that carries no ARN", async () => {
		const logged = captureLogs();
		vi.stubGlobal("fetch", async () => new Response("<GetCallerIdentityResponse></GetCallerIdentityResponse>", { status: 200 }));
		expect(await relayStsGetCallerIdentityArn(signedRequest(true))).toBeNull();
		expect(logged).toHaveLength(1);
		expect(JSON.parse(logged[0] as string)).toMatchObject({
			event: "sts_relay_failed",
			reason: "no_arn_in_response",
			status: 200,
			bodySnippet: "<GetCallerIdentityResponse></GetCallerIdentityResponse>",
		});
		expectNoSecrets(logged);
	});

	it("logs nothing on success", async () => {
		const logged = captureLogs();
		vi.stubGlobal("fetch", async () => new Response(STS_XML, { status: 200 }));
		expect(await relayStsGetCallerIdentityArn(signedRequest(true))).toBe(ARN);
		expect(logged).toEqual([]);
	});
});
