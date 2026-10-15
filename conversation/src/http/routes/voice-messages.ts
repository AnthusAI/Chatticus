import type { Context } from "hono";
import { assertIntegrationTestUserId } from "../../auth/integration-test.ts";
import { postVoiceMessage, type VoiceMessageDependencies } from "../../domain/voice-messages.ts";
import { isRefusal, pathParameter, resolveUserPrincipal, type UserPrincipalDependencies } from "../user-principal.ts";
import { messagePayload } from "./messages.ts";

/** Everything the voice message route depends on. */
export interface VoiceMessageRouteDependencies extends UserPrincipalDependencies {
	voice: VoiceMessageDependencies;
}

/** The longest transcript a voice line may carry. */
export const MAX_TRANSCRIPT_CHARACTERS = 2000;

type VoiceMessageBody = { authorId: string; transcript: string; addressedToBotId: string };

function parseVoiceMessageBody(raw: unknown): VoiceMessageBody | null {
	if (typeof raw !== "object" || raw === null) {
		return null;
	}
	const body = raw as Record<string, unknown>;
	if (typeof body.author_id !== "string" || typeof body.addressed_to_bot_id !== "string") {
		return null;
	}
	if (typeof body.transcript !== "string") {
		return null;
	}
	const length = [...body.transcript].length;
	if (length < 1 || length > MAX_TRANSCRIPT_CHARACTERS) {
		return null;
	}
	return { authorId: body.author_id, transcript: body.transcript, addressedToBotId: body.addressed_to_bot_id };
}

/**
 * POST /orgs/{tenant_id}/channels/{channel_id}/voice-messages: understand a spoken line and post it. Answers
 * `{understood, degraded, message, turn_id}`; `message` and `turn_id` are null when the line carried no message.
 */
export async function postVoiceMessageHandler(c: Context, deps: VoiceMessageRouteDependencies): Promise<Response> {
	const principal = await resolveUserPrincipal(c, deps);
	if (isRefusal(principal)) {
		return principal;
	}
	const body = parseVoiceMessageBody(await c.req.json().catch(() => null));
	if (body === null) {
		return c.json(
			{ detail: `author_id, addressed_to_bot_id and a transcript of 1 to ${MAX_TRANSCRIPT_CHARACTERS} characters are required` },
			422,
		);
	}
	assertIntegrationTestUserId(principal, body.authorId);
	const result = await postVoiceMessage(deps.voice, {
		tenantId: pathParameter(c, "tenant_id"),
		channelId: pathParameter(c, "channel_id"),
		authorId: body.authorId,
		transcript: body.transcript,
		addressedToBotId: body.addressedToBotId,
		idempotencyKey: (c.req.header("Idempotency-Key") ?? "").trim() || null,
	});
	return c.json(
		{
			understood: result.understood,
			degraded: result.degraded,
			message: result.message === null ? null : messagePayload(result.message),
			turn_id: result.turnId,
		},
		200,
	);
}
