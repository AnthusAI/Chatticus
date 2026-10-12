import { describe, expect, it } from "vitest";
import { HOST_USER_HEADER } from "@chatticus/host-protocol";
import type { OwnerPollRequest } from "@chatticus/host-protocol/supervisor";
import { HostProtocolError, OwnerSupervisorClient } from "../../computer/host/src/protocol-client.ts";

type Seen = { readonly url: string; readonly method: string; readonly headers: Record<string, string>; readonly body: unknown; readonly hasSignal: boolean };

const bootstrapAnswer = {
	computer_id: "household-computer",
	supervisor_token: "supervisor-token-1",
	supervisor_token_expires_at: "2026-10-12T09:00:00.000Z",
	aws_credentials: { access_key_id: "ASIA1", secret_access_key: "secret", session_token: "session", expires_at: "2026-10-12T09:00:00.000Z" },
};

function clientAnswering(answers: Array<{ status: number; body: unknown }>) {
	const seen: Seen[] = [];
	const fetchFunction = (async (input: Request | URL | string, init?: RequestInit) => {
		seen.push({
			url: String(input),
			method: init?.method ?? "GET",
			headers: init?.headers as Record<string, string>,
			body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
			hasSignal: init?.signal instanceof AbortSignal,
		});
		const answer = answers.shift();
		if (answer === undefined) throw new Error("no answer scripted");
		return new Response(JSON.stringify(answer.body), { status: answer.status });
	}) as typeof fetch;
	const client = new OwnerSupervisorClient({
		baseUrl: "https://front-door.test",
		tenantId: "anthus",
		userId: "ryan",
		bootstrapToken: "bootstrap-token-1",
		requestTimeoutMilliseconds: 10_000,
		fetchFunction,
	});
	return { client, seen };
}

const pollRequest: OwnerPollRequest = {
	owner_id: "owner-1",
	generation: 1,
	protocol_version: 1,
	sequence: 0,
	state: "idle",
	active_turns: [],
};

const idleAnswer = { dispatches: [], drain: false, next_poll_ms: 1000 };

describe("OwnerSupervisorClient", () => {
	it("exchanges the bootstrap token once and speaks with the supervisor token after", async () => {
		const { client, seen } = clientAnswering([
			{ status: 200, body: bootstrapAnswer },
			{ status: 200, body: idleAnswer },
		]);
		const response = await client.bootstrap({ owner_id: "owner-1", generation: 1, protocol_version: 1 });
		await client.poll(pollRequest);
		expect(response.supervisor_token).toBe("supervisor-token-1");
		expect(seen[0]?.url).toBe("https://front-door.test/orgs/anthus/host/owner/bootstrap");
		expect(seen[0]?.headers["Authorization"]).toBe("Bearer bootstrap-token-1");
		expect(seen[1]?.url).toBe("https://front-door.test/orgs/anthus/host/owner/poll");
		expect(seen[1]?.headers["Authorization"]).toBe("Bearer supervisor-token-1");
		expect(seen.every((request) => request.method === "POST")).toBe(true);
	});

	it("carries the host user header and a timeout on every request", async () => {
		const { client, seen } = clientAnswering([
			{ status: 200, body: bootstrapAnswer },
			{ status: 200, body: idleAnswer },
			{ status: 200, body: { approved: false, reason: "work_pending" } },
		]);
		await client.bootstrap({ owner_id: "owner-1", generation: 1, protocol_version: 1 });
		await client.poll(pollRequest);
		await client.stopRequest({ owner_id: "owner-1", generation: 1, reason: "idle", active_turns: [] });
		for (const request of seen) {
			expect(request.headers[HOST_USER_HEADER]).toBe("ryan");
			expect(request.hasSignal).toBe(true);
		}
	});

	it("answers a vetoed stop as an answer and not as an error", async () => {
		const { client } = clientAnswering([
			{ status: 200, body: bootstrapAnswer },
			{ status: 200, body: { approved: false, reason: "dispatch_pending" } },
		]);
		await client.bootstrap({ owner_id: "owner-1", generation: 1, protocol_version: 1 });
		await expect(client.stopRequest({ owner_id: "owner-1", generation: 1, reason: "idle", active_turns: [] })).resolves.toEqual({
			approved: false,
			reason: "dispatch_pending",
		});
	});

	it("throws the status and the owner error code of a refusal", async () => {
		const { client } = clientAnswering([{ status: 409, body: { detail: "used", code: "bootstrap_already_used" } }]);
		const refusal = await client.bootstrap({ owner_id: "owner-1", generation: 1, protocol_version: 1 }).catch((error: unknown) => error);
		expect(refusal).toBeInstanceOf(HostProtocolError);
		expect((refusal as HostProtocolError).status).toBe(409);
		expect((refusal as HostProtocolError).code).toBe("bootstrap_already_used");
	});

	it("throws a refusal without a code when the body is not an owner error", async () => {
		const { client } = clientAnswering([{ status: 403, body: { detail: "owner credential is not valid for this organization" } }]);
		const refusal = await client.bootstrap({ owner_id: "owner-1", generation: 1, protocol_version: 1 }).catch((error: unknown) => error);
		expect((refusal as HostProtocolError).status).toBe(403);
		expect((refusal as HostProtocolError).code).toBeUndefined();
	});

	it("keeps the bootstrap token when the exchange is refused", async () => {
		const { client, seen } = clientAnswering([
			{ status: 503, body: { detail: "later", code: "credentials_unavailable" } },
			{ status: 200, body: bootstrapAnswer },
		]);
		await client.bootstrap({ owner_id: "owner-1", generation: 1, protocol_version: 1 }).catch(() => undefined);
		await client.bootstrap({ owner_id: "owner-1", generation: 1, protocol_version: 1 });
		expect(seen.map((request) => request.headers["Authorization"])).toEqual(["Bearer bootstrap-token-1", "Bearer bootstrap-token-1"]);
	});

	it("refuses to send a poll the protocol does not allow", async () => {
		const { client, seen } = clientAnswering([]);
		await expect(client.poll({ ...pollRequest, state: "serving" })).rejects.toThrow();
		await expect(client.poll({ ...pollRequest, extra: true } as never)).rejects.toThrow();
		expect(seen).toHaveLength(0);
	});

	it("reaches the computer routes with the supervisor token", async () => {
		const { client, seen } = clientAnswering([
			{ status: 200, body: bootstrapAnswer },
			{
				status: 200,
				body: {
					computer_id: "household-computer",
					tenant_id: "anthus",
					stopped: true,
					policy: "per_org",
					host_start_generation: 1,
					model_ready: false,
					workspace_ready: false,
					browser_ready: false,
					snapshot_generation: 0,
					disk_dirty: false,
					hydrate_required: false,
				},
			},
		]);
		await client.bootstrap({ owner_id: "owner-1", generation: 1, protocol_version: 1 });
		await client.setComputerStopped(true, 1);
		expect(seen[1]?.url).toBe("https://front-door.test/orgs/anthus/host/computer/state");
		expect(seen[1]?.headers["Authorization"]).toBe("Bearer supervisor-token-1");
		expect(seen[1]?.body).toEqual({ stopped: true, start_generation: 1 });
	});
});
