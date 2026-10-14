import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { EXPIRATION_MS } from "@smithy/core";
import { HttpResponse, type HttpRequest } from "@smithy/protocol-http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const START = new Date("2026-10-14T12:00:00.000Z");
const CREDENTIALS_LIFETIME_MILLISECONDS = 3600_000;

type Identity = { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: Date };

function identityEndingAt(label: string, expiration: Date): Identity {
	return { accessKeyId: `ASIA${label}`, secretAccessKey: `secret-${label}`, sessionToken: `session-${label}`, expiration };
}

function clientWith(provider: () => Promise<Identity>, signedAccessKeys: string[]): S3Client {
	return new S3Client({
		region: "us-east-1",
		credentials: provider,
		requestHandler: {
			handle: async (request: HttpRequest) => {
				const authorization = request.headers["authorization"] ?? request.headers["Authorization"] ?? "";
				const match = /Credential=([^/]+)\//.exec(authorization);
				signedAccessKeys.push(match?.[1] ?? "unsigned");
				return { response: new HttpResponse({ statusCode: 200, headers: {} }) };
			},
			updateHttpClientConfig: () => undefined,
			httpHandlerConfigs: () => ({}),
		},
	});
}

async function headOnce(client: S3Client): Promise<void> {
	await client.send(new HeadObjectCommand({ Bucket: "bucket", Key: "key" }));
}

describe("the AWS SDK and a credential provider (Phase 2b assumption A2)", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(START);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("reads the re-read window from the installed SDK as five minutes", () => {
		expect(EXPIRATION_MS).toBe(300_000);
	});

	it("asks the provider once while the credentials have more than five minutes left, then signs with them", async () => {
		const asked: string[] = [];
		const signed: string[] = [];
		const provider = async (): Promise<Identity> => {
			asked.push("asked");
			return identityEndingAt("FIRST", new Date(START.getTime() + CREDENTIALS_LIFETIME_MILLISECONDS));
		};
		const client = clientWith(provider, signed);
		await headOnce(client);
		vi.setSystemTime(new Date(START.getTime() + CREDENTIALS_LIFETIME_MILLISECONDS - EXPIRATION_MS - 1000));
		await headOnce(client);
		expect(asked).toHaveLength(1);
		expect(signed).toEqual(["ASIAFIRST", "ASIAFIRST"]);
	});

	it("asks the provider again, and signs with what it now returns, inside the last five minutes", async () => {
		const signed: string[] = [];
		let held = identityEndingAt("FIRST", new Date(START.getTime() + CREDENTIALS_LIFETIME_MILLISECONDS));
		let asked = 0;
		const provider = async (): Promise<Identity> => {
			asked += 1;
			return held;
		};
		const client = clientWith(provider, signed);
		await headOnce(client);
		held = identityEndingAt("SECOND", new Date(START.getTime() + 2 * CREDENTIALS_LIFETIME_MILLISECONDS));
		vi.setSystemTime(new Date(START.getTime() + CREDENTIALS_LIFETIME_MILLISECONDS - EXPIRATION_MS + 1000));
		await headOnce(client);
		expect(asked).toBe(2);
		expect(signed).toEqual(["ASIAFIRST", "ASIASECOND"]);
	});

	it("keeps signing with the credentials it already holds while the provider has nothing newer, as long as they have not ended", async () => {
		const signed: string[] = [];
		const first = identityEndingAt("FIRST", new Date(START.getTime() + CREDENTIALS_LIFETIME_MILLISECONDS));
		const provider = async (): Promise<Identity> => first;
		const client = clientWith(provider, signed);
		await headOnce(client);
		vi.setSystemTime(new Date(START.getTime() + CREDENTIALS_LIFETIME_MILLISECONDS - 1000));
		await headOnce(client);
		expect(signed).toEqual(["ASIAFIRST", "ASIAFIRST"]);
	});
});
