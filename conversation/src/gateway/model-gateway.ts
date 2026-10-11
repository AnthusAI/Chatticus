import type { Context } from "hono";
import { BILLED_VIA_VENDOR } from "../budget/models.ts";
import type { TurnControlStore } from "../domain/turns.ts";
import { recordVendorSpend, type VendorLedgerDependencies } from "../ledger/vendor-ledger.ts";
import { OPENAI_MODEL_PRICES } from "../ledger/vendor-prices.ts";
import { errorNameOf } from "../observability/log-line.ts";
import { verifySessionToken } from "./session-token.ts";

/** The vendor name spend is recorded under, matching the turn executor's ledger rows. */
export const GATEWAY_VENDOR = "openai";

/** The largest request body the gateway forwards, in bytes. A real replay of a long conversation is a few tens of kilobytes. */
export const GATEWAY_MAXIMUM_BODY_BYTES = 2 * 1024 * 1024;

/**
 * The most output tokens (reasoning included) one forwarded call may ask for. A request that asks for more, or for no
 * limit, is clamped to this. Pi sends the model's own maximum, 128000 for gpt-6-luna, which would let one call run for
 * minutes; 32768 leaves room for long reasoning plus a long reply and stops unbounded generation.
 */
export const GATEWAY_MAXIMUM_OUTPUT_TOKENS = 32768;

const ESTIMATED_CHARACTERS_PER_TOKEN = 4;

/**
 * A fact the gateway reports for operators. It names the refusal or failure and never carries a secret. The tenant, turn
 * and owner are present only when the token's signature verified; the claims of a token that did not verify are not
 * trusted enough to log.
 */
export type GatewayLogEvent = {
	readonly event: "refused" | "upstream_failed" | "spend_recorded" | "spend_unavailable";
	readonly reason: string;
	readonly tenantId?: string;
	readonly turnId?: string;
	readonly ownerId?: string;
	readonly status?: number;
	/** The name of the error that ended an upstream request, never its message. */
	readonly errorName?: string;
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

const refusal = (c: Context, deps: ModelGatewayDependencies, status: 400 | 401 | 403 | 413 | 422, detail: string, reason: string, scope: Partial<GatewayLogEvent> = {}): Response => {
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
	return async (usage: Usage | null, reason: string): Promise<void> => {
		if (usage === null) {
			deps.log({ event: "spend_unavailable", reason: "the answer carried no final usage", tenantId, turnId });
			return;
		}
		await recordVendorSpend(deps.ledger, tenantId, turnId, { vendor: GATEWAY_VENDOR, model, ...usage }, BILLED_VIA_VENDOR);
		deps.log({ event: "spend_recorded", reason, tenantId, turnId });
	};
}

type StreamAccount = { final: Usage | null; outputCharacters: number };

/**
 * Pass an event stream through unchanged, chunk by chunk, while watching for the final usage event. When the stream
 * ends, the spend is recorded once, before the client sees the end of its answer. When the client drops the connection
 * or the upstream breaks first, the spend is still recorded once, as an estimate: the input is counted from the request
 * and the output from the text already sent.
 */
function meteredStream(
	upstream: ReadableStream<Uint8Array>,
	record: (usage: Usage | null, reason: string) => Promise<void>,
	estimatedInputTokens: number,
): ReadableStream<Uint8Array> {
	const reader = upstream.getReader();
	const decoder = new TextDecoder();
	const account: StreamAccount = { final: null, outputCharacters: 0 };
	let pending = "";
	let recorded = false;
	let cancelled = false;
	const recordOnce = async (usage: Usage | null, reason: string): Promise<void> => {
		if (recorded) return;
		recorded = true;
		await record(usage, reason);
	};
	const recordEstimate = (): Promise<void> =>
		account.final === null
			? recordOnce(
					{ inputTokens: estimatedInputTokens, outputTokens: Math.ceil(account.outputCharacters / ESTIMATED_CHARACTERS_PER_TOKEN) },
					"estimated_after_interruption",
				)
			: recordOnce(account.final, "recorded");
	const scan = (text: string, final: boolean): void => {
		pending += text;
		const blocks = pending.split("\n\n");
		pending = final ? "" : (blocks.pop() ?? "");
		if (final && blocks.length > 0 && blocks[blocks.length - 1] === "") blocks.pop();
		for (const block of blocks) {
			account.outputCharacters += deltaCharactersOf(block);
			account.final = usageFromEvent(block) ?? account.final;
		}
	};
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			let chunk: ReadableStreamReadResult<Uint8Array>;
			try {
				chunk = await reader.read();
			} catch (error) {
				if (cancelled) return;
				await recordEstimate();
				controller.error(error);
				return;
			}
			if (cancelled) return;
			if (chunk.done) {
				scan(decoder.decode(), true);
				await recordOnce(account.final, "recorded");
				controller.close();
				return;
			}
			controller.enqueue(chunk.value);
			scan(decoder.decode(chunk.value, { stream: true }), false);
		},
		async cancel(reason) {
			cancelled = true;
			await reader.cancel(reason).catch(() => undefined);
			await recordEstimate();
		},
	});
}

function deltaCharactersOf(block: string): number {
	for (const line of block.split("\n")) {
		if (!line.startsWith("data:")) continue;
		try {
			const parsed = JSON.parse(line.slice("data:".length).trim()) as { delta?: unknown };
			return typeof parsed.delta === "string" ? parsed.delta.length : 0;
		} catch {
			return 0;
		}
	}
	return 0;
}

type AdmittedBody = { readonly text: string; readonly model: string };
type RefusedBody = { readonly refusal: string; readonly reason: string };

const BAD_BODY: RefusedBody = { refusal: "body must be a JSON object naming a model", reason: "bad_body" };
const TOOL_NOT_ALLOWED: RefusedBody = { refusal: "only function tools are allowed through the gateway", reason: "tool_not_allowed" };

/**
 * Check a request body against what the gateway lets a container ask for and return the body to forward. The model must
 * be one the price book prices, the output limit is clamped to the ceiling, `store` is forced off, and only function
 * tools may be offered; a request for `store`, `background` or any other tool is refused.
 */
function admittedBody(bodyText: string): AdmittedBody | RefusedBody {
	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		return BAD_BODY;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return BAD_BODY;
	const body = { ...(parsed as Record<string, unknown>) };
	if (typeof body.model !== "string" || body.model === "") return BAD_BODY;
	if (!Object.hasOwn(OPENAI_MODEL_PRICES, body.model)) return { refusal: "model is not allowed through the gateway", reason: "model_not_allowed" };
	if (body.store === true || body.background === true) {
		return { refusal: "store and background are not allowed through the gateway", reason: "field_not_allowed" };
	}
	if (body.tools !== undefined) {
		const tools = body.tools;
		const functionsOnly = Array.isArray(tools) && tools.every((tool) => typeof tool === "object" && tool !== null && (tool as { type?: unknown }).type === "function");
		if (!functionsOnly) return TOOL_NOT_ALLOWED;
	}
	const choice = body.tool_choice;
	if (typeof choice === "object" && choice !== null) {
		const choiceType = (choice as { type?: unknown }).type;
		if (choiceType !== "function" && choiceType !== "allowed_tools") return TOOL_NOT_ALLOWED;
	}
	body.store = false;
	const requested = body.max_output_tokens;
	if (typeof requested !== "number" || !Number.isFinite(requested) || requested > GATEWAY_MAXIMUM_OUTPUT_TOKENS) {
		body.max_output_tokens = GATEWAY_MAXIMUM_OUTPUT_TOKENS;
	}
	return { text: JSON.stringify(body), model: body.model };
}

/**
 * POST /orgs/{tenant_id}/model-gateway/v1/responses: forward one OpenAI Responses request for a container's Pi session.
 *
 * The caller proves itself with a session token, not a key: the token must verify, name the organization in the path,
 * and name the owner that claimed the current attempt of a running turn of that organization and bot. The request body is sent
 * to the vendor with the real key, and the answer streams back as it arrives. The spend is recorded once, from the
 * final usage event, or as an estimate when the client drops the connection first.
 *
 * The caller does not get the whole vendor API. The body must be at most `GATEWAY_MAXIMUM_BODY_BYTES`, name a model on
 * the price book, offer only function tools and ask for neither `store` nor `background`; `max_output_tokens` is clamped
 * to `GATEWAY_MAXIMUM_OUTPUT_TOKENS` and `store` is forced off. The vendor's own error text is never passed on, because a vendor can echo part of a key.
 *
 * @param c The request context.
 * @param deps The signing key, turn store, ledger, vendor and log.
 */
export async function modelGatewayResponsesHandler(c: Context, deps: ModelGatewayDependencies): Promise<Response> {
	const token = bearerTokenOf(c);
	if (token === null) return refusal(c, deps, 401, "model gateway token required", "missing_header");
	const verification = verifySessionToken(deps.signingKey, token, deps.clock.now());
	if (!verification.valid) {
		const reason = verification.reason === "signature" ? "tampered" : verification.reason;
		return refusal(c, deps, 401, "invalid model gateway token", reason);
	}
	const { claims } = verification;
	const scope = { tenantId: claims.tenantId, turnId: claims.turnId, ownerId: claims.ownerId };
	if (c.req.param("tenant_id") !== claims.tenantId) {
		return refusal(c, deps, 403, "token is not valid for this organization", "organization_mismatch", scope);
	}
	const turn = await deps.turns.getTurn(claims.tenantId, claims.turnId);
	const notRunning = (reason: string): Response => refusal(c, deps, 403, "token is not valid for a running turn", reason, scope);
	if (turn === null || turn.botId !== claims.botId) return notRunning("wrong_turn");
	if (turn.status !== "active") return notRunning("finished_turn");
	if (turn.claimedBy !== claims.ownerId) return notRunning("wrong_owner");
	const declaredLength = Number(c.req.header("Content-Length") ?? "0");
	if (declaredLength > GATEWAY_MAXIMUM_BODY_BYTES) return refusal(c, deps, 413, "request body is too large", "body_too_large", scope);
	const bodyText = await c.req.text();
	const bodyBytes = Buffer.byteLength(bodyText);
	if (bodyBytes > GATEWAY_MAXIMUM_BODY_BYTES) return refusal(c, deps, 413, "request body is too large", "body_too_large", scope);
	const admitted = admittedBody(bodyText);
	if ("refusal" in admitted) return refusal(c, deps, admitted.reason === "bad_body" ? 422 : 400, admitted.refusal, admitted.reason, scope);
	const { model } = admitted;
	const estimatedInputTokens = Math.ceil(bodyBytes / ESTIMATED_CHARACTERS_PER_TOKEN);

	let upstreamResponse: Response;
	try {
		upstreamResponse = await deps.upstream.fetch(`${deps.upstream.baseUrl}/responses`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: c.req.header("Accept") ?? "application/json",
				authorization: `Bearer ${deps.upstream.apiKey}`,
			},
			body: admitted.text,
			signal: c.req.raw.signal,
		});
	} catch (error) {
		deps.log({ event: "upstream_failed", reason: "request_did_not_complete", errorName: errorNameOf(error), ...scope });
		return c.json({ detail: "model provider request failed" }, 502);
	}
	if (!upstreamResponse.ok || upstreamResponse.body === null) {
		deps.log({ event: "upstream_failed", reason: "provider_refused", status: upstreamResponse.status, ...scope });
		return c.json({ detail: "model provider request failed", upstream_status: upstreamResponse.status }, 502);
	}

	const record = spendRecorderFor(deps, claims.tenantId, claims.turnId, model);
	const contentType = upstreamResponse.headers.get("content-type") ?? "application/json";
	if (contentType.startsWith("text/event-stream")) {
		return new Response(meteredStream(upstreamResponse.body, record, estimatedInputTokens), {
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
	await record(answerUsage, "recorded");
	return new Response(answerText, { status: 200, headers: { "content-type": contentType, "cache-control": "no-store" } });
}
