import { KanbusApiError, createKanbusApiClient, type KanbusIssue } from "@kanbus/api-client";
import { describe, expect, it } from "vitest";
import { botBoardServiceFromEnvironment } from "../src/board/bot-board-service-factory.ts";
import { deriveBoardOperationId } from "../src/board/board-operation-id.ts";
import { UNCONFIRMED_WRITE_MESSAGE, failureFromError } from "../src/board/board-failures.ts";
import { createSigV4SignedFetch, kanbusApiUrlFrom } from "../src/board/kanbus-board-client.ts";
import { FakeKanbusBoardService } from "../features-support/fakes/fake-kanbus-board-service.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("board operation ids", () => {
	it("derives the same UUID from the same parts and a different one from different parts", () => {
		const parts = ["bot-board", "org", "bot", "update", "update", "turn/call"];
		expect(deriveBoardOperationId(parts)).toBe(deriveBoardOperationId(parts));
		expect(deriveBoardOperationId(parts)).toMatch(UUID_PATTERN);
		expect(deriveBoardOperationId([...parts.slice(0, 5), "turn/other"])).not.toBe(deriveBoardOperationId(parts));
		expect(deriveBoardOperationId(["ab", "c"])).not.toBe(deriveBoardOperationId(["a", "bc"]));
	});
});

describe("board failures", () => {
	const kanbusError = (status: number, code: string): KanbusApiError => new KanbusApiError({ status, code, message: `${code} message` });

	it("maps the codes the store sends onto what the caller acts on", () => {
		expect(failureFromError(kanbusError(409, "revision_conflict")).kind).toBe("conflict");
		expect(failureFromError(kanbusError(409, "operation_conflict")).kind).toBe("operation_conflict");
		expect(failureFromError(kanbusError(409, "board_archived")).kind).toBe("archived");
		expect(failureFromError(kanbusError(403, "forbidden")).kind).toBe("forbidden");
		expect(failureFromError(kanbusError(404, "not_found")).kind).toBe("not_found");
		expect(failureFromError(kanbusError(400, "invalid_issue")).kind).toBe("invalid");
		expect(failureFromError(kanbusError(409, "hierarchy_violation")).kind).toBe("invalid");
		expect(failureFromError(kanbusError(409, "board_not_archived")).kind).toBe("invalid");
	});

	it("never reports an unconfirmed write as anything but unavailable", () => {
		for (const error of [new TypeError("fetch failed"), kanbusError(503, "storage_unavailable"), kanbusError(500, "unrecognized_error"), kanbusError(502, "something_new")]) {
			const failure = failureFromError(error);
			expect(failure.kind).toBe("unavailable");
			expect(failure.message).toBe(UNCONFIRMED_WRITE_MESSAGE);
		}
	});

	it("does not reveal whether a forbidden board exists", () => {
		expect(failureFromError(kanbusError(403, "forbidden")).message).not.toMatch(/exist/i);
	});
});

describe("board service client wiring", () => {
	it("is off unless the board service URL is set", () => {
		expect(kanbusApiUrlFrom({})).toBeNull();
		expect(kanbusApiUrlFrom({ CHATTICUS_KANBUS_API_URL: "" })).toBeNull();
		expect(kanbusApiUrlFrom({ CHATTICUS_KANBUS_API_URL: "https://kanbus.example.com" })).toBe("https://kanbus.example.com");
		const options = { credentials: async () => ({ accessKeyId: "a", secretAccessKey: "b" }), memberships: { getMembership: async () => null } };
		expect(botBoardServiceFromEnvironment({}, options)).toBeNull();
		expect(() => botBoardServiceFromEnvironment({ CHATTICUS_KANBUS_API_URL: "https://kanbus.example.com" }, options)).toThrow(/AWS_REGION/);
		expect(botBoardServiceFromEnvironment({ CHATTICUS_KANBUS_API_URL: "https://kanbus.example.com", AWS_REGION: "us-east-1" }, options)).not.toBeNull();
	});

	it("signs each request for execute-api with the role credentials and keeps the actor header signed", async () => {
		const seen: Array<{ url: string; headers: Record<string, string> }> = [];
		const signedFetch = createSigV4SignedFetch({
			credentials: async () => ({ accessKeyId: "test-key-id", secretAccessKey: "secret", sessionToken: "token" }),
			region: "eu-west-1",
			fetch: async (url, init) => {
				seen.push({ url, headers: init?.headers as Record<string, string> });
				return new Response("{}", { status: 200 });
			},
		});
		const client = createKanbusApiClient({
			baseUrl: "https://abc.execute-api.eu-west-1.amazonaws.com",
			fetch: signedFetch,
			headers: () => ({ "X-Kanbus-Actor": "chatticus:bot:b1" }),
		});
		await client.board("org-1", "bot-1").getConfig();
		const headers = Object.fromEntries(Object.entries(seen[0]!.headers).map(([name, value]) => [name.toLowerCase(), value]));
		expect(seen[0]!.url).toBe("https://abc.execute-api.eu-west-1.amazonaws.com/org-1/bot-1/api/config");
		expect(headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 Credential=test-key-id\/\d{8}\/eu-west-1\/execute-api\/aws4_request/);
		expect(headers["authorization"]).toMatch(/SignedHeaders=[^,]*x-kanbus-actor/);
		expect(headers["x-amz-security-token"]).toBe("token");
	});
});

describe("the in-process model of the board service", () => {
	it("answers the published client with the issue shape the client types promise", async () => {
		const service = new FakeKanbusBoardService(() => new Date("2026-10-20T12:00:00.000Z"));
		service.registerPrincipal("provision-key-id", { secretAccessKey: "secret", provision: true, delegateActor: true, tenants: "*" });
		const signedFetch = createSigV4SignedFetch({
			credentials: async () => ({ accessKeyId: "provision-key-id", secretAccessKey: "secret" }),
			region: "us-east-1",
			fetch: service.fetch,
		});
		const board = createKanbusApiClient({ baseUrl: "https://kanbus.invalid", fetch: signedFetch, headers: () => ({ "X-Kanbus-Actor": "chatticus:user:u1" }) }).board("org", "bot");
		await board.provision({ operationId: deriveBoardOperationId(["p"]) });
		const written = await board.createIssue({ title: "A card", type: "task" }, { operationId: deriveBoardOperationId(["c"]), actor: "chatticus:user:u1" });
		const issue: KanbusIssue = written.issue;
		expect(typeof written.revision).toBe("string");
		expect(typeof written.catalog_pending).toBe("boolean");
		expect(issue.id).toMatch(/^kanbus-[0-9a-f-]{36}$/);
		expect(issue.closed_at).toBeNull();
		expect(issue.assignee).toBeNull();
		expect(issue.parent).toBeNull();
		expect(issue.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		await expect(board.updateIssue(issue.id, { status: "closed" }, { operationId: deriveBoardOperationId(["u"]), ifMatch: "revision-0", actor: "chatticus:user:u1" })).rejects.toMatchObject({ status: 409, code: "revision_conflict" });
	});

	it("refuses a request that is not signed by a registered role", async () => {
		const service = new FakeKanbusBoardService(() => new Date());
		const board = createKanbusApiClient({ baseUrl: "https://kanbus.invalid", fetch: service.fetch }).board("org", "bot");
		await expect(board.getConfig()).rejects.toMatchObject({ status: 403 });
	});
});

describe("the in-process model verifies the request signature", () => {
	const EMPTY_BODY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
	const url = "https://kanbus.invalid/org/bot/api/issues";
	const credentials = { accessKeyId: "verify-key-id", secretAccessKey: "verify-secret" };

	const setup = () => {
		const service = new FakeKanbusBoardService(() => new Date("2026-10-20T12:00:00.000Z"));
		service.registerPrincipal("verify-key-id", { secretAccessKey: "verify-secret", provision: true, delegateActor: true, tenants: "*" });
		return service;
	};

	const signed = async (body: string, overrides: Record<string, string> = {}): Promise<Record<string, string>> => {
		const { signSigV4 } = await import("../src/acceptance/sigv4.ts");
		const { createHash } = await import("node:crypto");
		return signSigV4(
			{
				method: "POST",
				url,
				headers: {
					"x-kanbus-actor": "chatticus:bot:b",
					"x-operation-id": deriveBoardOperationId(["signed-request"]),
					"x-amz-content-sha256": createHash("sha256").update(body).digest("hex"),
					...overrides,
				},
				body,
			},
			credentials,
			"us-east-1",
			"execute-api",
		);
	};

	const send = async (service: FakeKanbusBoardService, headers: Record<string, string>, body: string): Promise<number> =>
		(await service.fetch(url, { method: "POST", headers, body })).status;

	it("accepts a request signed over the exact body it sends", async () => {
		const body = JSON.stringify({ title: "x", type: "task" });
		expect(await send(setup(), await signed(body), body)).toBe(404);
	});

	it("refuses a request signed with the hash of an empty body", async () => {
		const body = JSON.stringify({ title: "x", type: "task" });
		expect(await send(setup(), await signed(body, { "x-amz-content-sha256": EMPTY_BODY_HASH }), body)).toBe(403);
	});

	it("refuses a request whose body changed after signing", async () => {
		const headers = await signed(JSON.stringify({ title: "x", type: "task" }));
		expect(await send(setup(), headers, JSON.stringify({ title: "y", type: "task" }))).toBe(403);
	});

	it("refuses a request whose signed header was altered", async () => {
		const body = JSON.stringify({ title: "x", type: "task" });
		const headers = { ...(await signed(body)), "x-kanbus-actor": "chatticus:user:someone-else" };
		expect(await send(setup(), headers, body)).toBe(403);
	});

	it("refuses a request signed without the payload hash header", async () => {
		const body = JSON.stringify({ title: "x", type: "task" });
		const headers = await signed(body);
		delete headers["x-amz-content-sha256"];
		expect(await send(setup(), headers, body)).toBe(403);
	});

	it("refuses a client that signs in its headers hook, which cannot see the method, the url or the body", async () => {
		const service = setup();
		const { signSigV4 } = await import("../src/acceptance/sigv4.ts");
		const headersHook = async (): Promise<Record<string, string>> =>
			signSigV4({ method: "GET", url: "https://kanbus.invalid/", headers: {} }, credentials, "us-east-1", "execute-api");
		const board = createKanbusApiClient({ baseUrl: "https://kanbus.invalid", fetch: service.fetch, headers: headersHook }).board("org", "bot");
		await expect(board.createIssue({ title: "x", type: "task" }, { operationId: deriveBoardOperationId(["h"]), actor: "chatticus:bot:b" })).rejects.toMatchObject({ status: 403 });
	});
});

describe("the signed query is the query that is sent", () => {
	it("verifies a listing whose query holds characters that URI encodings treat differently", async () => {
		const service = new FakeKanbusBoardService(() => new Date("2026-10-20T12:00:00.000Z"));
		service.registerPrincipal("query-key-id", { secretAccessKey: "query-secret", provision: true, delegateActor: true, tenants: "*" });
		const signedFetch = createSigV4SignedFetch({
			credentials: async () => ({ accessKeyId: "query-key-id", secretAccessKey: "query-secret" }),
			region: "us-east-1",
			fetch: service.fetch,
		});
		const board = createKanbusApiClient({ baseUrl: "https://kanbus.invalid", fetch: signedFetch, headers: () => ({ "X-Kanbus-Actor": "chatticus:user:u1" }) }).board("org", "bot");
		await board.provision({ operationId: deriveBoardOperationId(["q"]) });
		for (const search of ["a*b", "a!b", "a'b", "a(b)", "a b", "a+b&c=d", "ü~._-"]) {
			await expect(board.listIssues({ search, status: "open" })).resolves.toMatchObject({ issues: [] });
		}
	});
});
