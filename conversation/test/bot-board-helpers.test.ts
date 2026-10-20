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
		service.registerPrincipal("provision-key-id", { provision: true, delegateActor: true, tenants: "*" });
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
