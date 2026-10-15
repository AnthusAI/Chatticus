import { describe, expect, it } from "vitest";
import { HttpClient } from "../src/acceptance/http-client.ts";

const recordingFetch = (requestedUrls: string[]): typeof fetch =>
	(async (input: string | URL | Request) => {
		requestedUrls.push(String(input));
		return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
	}) as typeof fetch;

describe("the acceptance HTTP client keeps the path of its base URL", () => {
	it("sends requests under /api when the base URL ends in /api (the CloudFront behavior that reaches the app)", async () => {
		const requestedUrls: string[] = [];
		const client = new HttpClient({ baseUrl: "https://develop.example.test/api", fetch: recordingFetch(requestedUrls) });
		await client.post("/integration-test/session");
		expect(requestedUrls).toEqual(["https://develop.example.test/api/integration-test/session"]);
	});

	it("sends requests to the root path for a base URL with no path (a Function URL)", async () => {
		const requestedUrls: string[] = [];
		const client = new HttpClient({ baseUrl: "https://abc.lambda-url.example.test/", fetch: recordingFetch(requestedUrls) });
		await client.post("/integration-test/session");
		expect(requestedUrls).toEqual(["https://abc.lambda-url.example.test/integration-test/session"]);
	});
});
