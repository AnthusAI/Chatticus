import { afterEach, describe, expect, it, vi } from "vitest";
import { relayStsGetCallerIdentityArn } from "../src/auth/integration-test.ts";
import { invokeKeysMatch } from "../src/http/app.ts";

const ARN = "arn:aws:sts::123456789012:assumed-role/runner/session";
const STS_XML = `<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>${ARN}</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>`;

afterEach(() => {
	vi.unstubAllGlobals();
});

function lambdaStyleRequest(): Request {
	return new Request("https://abc123.lambda-url.us-east-1.on.aws/integration-test/session", {
		method: "POST",
		headers: {
			host: "abc123.lambda-url.us-east-1.on.aws",
			authorization: "AWS4-HMAC-SHA256 Credential=x, SignedHeaders=host;x-amz-date;x-amz-security-token, Signature=00",
			"x-amz-date": "20261006T170715Z",
			"x-amz-security-token": "token",
			"x-chatticus-invoke-key": "secret",
		},
	});
}

describe("relayStsGetCallerIdentityArn", () => {
	it("sends only the three signed headers to STS and returns the caller ARN", async () => {
		const captured: Array<{ url: string; headers: Record<string, string> }> = [];
		vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string> }) => {
			captured.push({ url: String(url), headers: Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v])) });
			return new Response(STS_XML, { status: 200 });
		});
		expect(await relayStsGetCallerIdentityArn(lambdaStyleRequest())).toBe(ARN);
		expect(captured).toHaveLength(1);
		expect(captured[0]?.url).toBe("https://sts.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15");
		expect(Object.keys(captured[0]?.headers ?? {}).sort()).toEqual(["authorization", "x-amz-date", "x-amz-security-token"]);
	});

	it("answers null without calling STS when there is no authorization header", async () => {
		const fetchStub = vi.fn();
		vi.stubGlobal("fetch", fetchStub);
		expect(await relayStsGetCallerIdentityArn(new Request("https://abc123.lambda-url.us-east-1.on.aws/x", { method: "POST" }))).toBeNull();
		expect(fetchStub).not.toHaveBeenCalled();
	});
});

describe("invokeKeysMatch", () => {
	it("matches equal keys and rejects different keys of any length without throwing", () => {
		expect(invokeKeysMatch("secret", "secret")).toBe(true);
		expect(invokeKeysMatch("secreu", "secret")).toBe(false);
		expect(invokeKeysMatch("short", "a-much-longer-secret")).toBe(false);
		expect(invokeKeysMatch("", "secret")).toBe(false);
	});
});
