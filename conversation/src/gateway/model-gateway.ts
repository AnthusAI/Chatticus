import type { Context } from "hono";
import { BILLED_VIA_VENDOR } from "../budget/models.ts";
import type { TurnControlStore } from "../domain/turns.ts";
import { recordVendorSpend, type VendorLedgerDependencies } from "../ledger/vendor-ledger.ts";
import { verifySessionToken } from "./session-token.ts";

/** The vendor name spend is recorded under, matching the turn executor's ledger rows. */
export const GATEWAY_VENDOR = "openai";

/** A fact the gateway reports for operators. It names the refusal or failure and never carries a secret. */
export type GatewayLogEvent = {
	readonly event: "refused" | "upstream_failed" | "spend_recorded" | "spend_unavailable";
	readonly reason: string;
	readonly tenantId?: string;
	readonly turnId?: string;
	readonly status?: number;
};

/** The vendor the gateway forwards to, and the real key it holds. */
export type GatewayUpstream = {
	/** Address of the vendor's API, for example `https://api.openai.com/v1`. */
	readonly baseUrl: string;
	/** The real vendor key. It is sent upstream only and appears in no response, header or log event. */
	readonly apiKey: string;
	/** The function that sends the upstream request; tests inject a fake. */
	readonly fetch: typeof fetch;
};

/** Everything the model gateway route depends on. */
export type ModelGatewayDependencies = {
	/** Secret the session tokens are signed with. */
	readonly signingKey: string;
	readonly clock: { now(): Date };
	readonly turns: Pick<TurnControlStore, "getTurn">;
	readonly ledger: VendorLedgerDependencies;
	readonly upstream: GatewayUpstream;
	readonly log: (event: GatewayLogEvent) => void;
};

type Usage = { inputTokens: number; outputTokens: number };

const refusal = (c: Context, deps: ModelGatewayDependencies, status: 401 | 403 | 422, detail: string, reason: string, scope: Partial<GatewayLogEvent> = {}): Response => {
	deps.log({ event: "refused", reason, ...scope });
	return c.json({ detail }, status);
};

function bearerTokenOf(c: Context): string | null {
	const header = c.req.header("Authorization") ?? "";
	const match = /^Bearer (\S+)$/.exec(header);
	return match === null ? null : match[1]!;
}

function usageFrom(response: unknown): Usage | null {
	if (typeof response !== "object" || response === null) return null;
	const usage = (response as { usage?: unknown }).usage;
	if (typeof usage !== "object" || usage === null) return null;
	const { input_tokens: input, output_tokens: output } = usage as Record<string, unknown>;
	if (typeof input !== "number" || typeof output !== "number") return null;
	return { inputTokens: input, outputTokens: output };
}

function usageFromEvent(block: string): Usage | null {
	for (const line of block.split("\n")) {
		if (!line.startsWith("data:")) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line.slice("data:".length).trim());
		} catch {
			return null;
		}
		if (typeof parsed !== "object" || parsed === null) return null;
		const { type, response } = parsed as { type?: unknown; response?: unknown };
		if (type === "response.completed" || type === "response.incomplete") return usageFrom(response);
	}
	return null;
}

function spendRecorderFor(deps: ModelGatewayDependencies, tenantId: string, turnId: string, model: string) {
	return async (usage: Usage | null): Promise<void> => {
		if (usage === null) {
			deps.log({ event: "spend_unavailable", reason: "the answer carried no final usage", tenantId, turnId });
			return;
		}
		await recordVendorSpend(deps.ledger, tenantId, turnId, { vendor: GATEWAY_VENDOR, model, ...usage }, BILLED_VIA_VENDOR);
		deps.log({ event: "spend_recorded", reason: "recorded", tenantId, turnId });
	};
}

/**
 * Pass an event stream through unchanged, chunk by chunk, while watching for the final usage event. When the stream
 * ends, the spend is recorded once, before the client sees the end of its answer.
 */
function meteredStream(upstream: ReadableStream<Uint8Array>, record: (usage: Usage | null) => Promise<void>): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	let pending = "";
	let usage: Usage | null = null;
	const scan = (text: string, final: boolean): void => {
		pending += text;
		const blocks = pending.split("\n\n");
		pending = final ? "" : (blocks.pop() ?? "");
		if (final && blocks.length > 0 && blocks[blocks.length - 1] === "") blocks.pop();
		for (const block of blocks) usage = usageFromEvent(block) ?? usage;
	};
	return upstream.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				controller.enqueue(chunk);
				scan(decoder.decode(chunk, { stream: true }), false);
			},
			async flush() {
				scan(decoder.decode(), true);
				await record(usage);
			},
		}),
	);
}

/**
 * POST /orgs/{tenant_id}/model-gateway/v1/responses: forward one OpenAI Responses request for a container's Pi session.
 *
 * The caller proves itself with a session token, not a key: the token must verify, name the organization in the path,
 * and belong to the attempt that currently owns an active turn of that organization and bot. The request body is sent
 * to the vendor with the real key, and the answer streams back as it arrives. The spend is recorded once, from the
 * final usage event. The vendor's own error text is never passed on, because a vendor can echo part of a key.
 *
 * @param c The request context.
 * @param deps The signing key, turn store, ledger, vendor and log.
 */
export async function modelGatewayResponsesHandler(c: Context, deps: ModelGatewayDependencies): Promise<Response> {
	const token = bearerTokenOf(c);
	if (token === null) return refusal(c, deps, 401, "model gateway token required", "no bearer token");
	const verification = verifySessionToken(deps.signingKey, token, deps.clock.now());
	if (!verification.valid) return refusal(c, deps, 401, "invalid model gateway token", verification.reason);
	const { claims } = verification;
	const scope = { tenantId: claims.tenantId, turnId: claims.turnId };
	if (c.req.param("tenant_id") !== claims.tenantId) {
		return refusal(c, deps, 403, "token is not valid for this organization", "organization mismatch", scope);
	}
	const turn = await deps.turns.getTurn(claims.tenantId, claims.turnId);
	if (
		turn === null ||
		turn.status !== "active" ||
		turn.botId !== claims.botId ||
		turn.attemptId !== claims.attemptId
	) {
		return refusal(c, deps, 403, "token is not valid for a running turn", "turn is not running for this token", scope);
	}
	const bodyText = await c.req.text();
	let model = "";
	try {
		const body = JSON.parse(bodyText) as { model?: unknown };
		if (typeof body.model === "string") model = body.model;
	} catch {
		model = "";
	}
	if (model === "") return refusal(c, deps, 422, "body must be a JSON object naming a model", "bad body", scope);

	let upstreamResponse: Response;
	try {
		upstreamResponse = await deps.upstream.fetch(`${deps.upstream.baseUrl}/responses`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: c.req.header("Accept") ?? "application/json",
				authorization: `Bearer ${deps.upstream.apiKey}`,
			},
			body: bodyText,
			signal: c.req.raw.signal,
		});
	} catch {
		deps.log({ event: "upstream_failed", reason: "request did not complete", ...scope });
		return c.json({ detail: "model provider request failed" }, 502);
	}
	if (!upstreamResponse.ok || upstreamResponse.body === null) {
		deps.log({ event: "upstream_failed", reason: "provider refused", status: upstreamResponse.status, ...scope });
		return c.json({ detail: "model provider request failed", upstream_status: upstreamResponse.status }, 502);
	}

	const record = spendRecorderFor(deps, claims.tenantId, claims.turnId, model);
	const contentType = upstreamResponse.headers.get("content-type") ?? "application/json";
	if (contentType.startsWith("text/event-stream")) {
		return new Response(meteredStream(upstreamResponse.body, record), {
			status: 200,
			headers: { "content-type": contentType, "cache-control": "no-store" },
		});
	}
	const answerText = await upstreamResponse.text();
	let answerUsage: Usage | null = null;
	try {
		answerUsage = usageFrom(JSON.parse(answerText));
	} catch {
		answerUsage = null;
	}
	await record(answerUsage);
	return new Response(answerText, { status: 200, headers: { "content-type": contentType, "cache-control": "no-store" } });
}
