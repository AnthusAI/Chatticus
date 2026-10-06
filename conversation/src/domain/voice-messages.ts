import { randomUUID } from "node:crypto";
import { BILLED_VIA_VENDOR } from "../budget/models.ts";
import { recordVendorSpend, type VendorLedgerDependencies } from "../ledger/vendor-ledger.ts";
import {
	RECENT_LINES_FOR_UNDERSTANDING,
	type RecentLine,
	understandOrTakeAsHeard,
	type UserUnderstanding,
	wordCount,
} from "../voice/understanding.ts";
import { requireChannelTenant } from "./channels.ts";
import { listMessages, type Message, type MessageDependencies, postMessage, requireParticipant } from "./messages.ts";

/** What a voice line needs beyond message admission: the understanding step and the ledger its spend goes to. */
export type VoiceMessageDependencies = {
	readonly messages: MessageDependencies;
	readonly understanding: UserUnderstanding;
	readonly ledger: VendorLedgerDependencies;
};

/** One spoken line to understand and post. */
export type VoiceMessageRequest = {
	tenantId: string;
	channelId: string;
	authorId: string;
	transcript: string;
	addressedToBotId: string;
	idempotencyKey: string | null;
};

/** What a voice line came to: the text understood, whether the transcript was taken as heard, and what was posted. */
export type VoiceMessageResult = {
	understood: string;
	degraded: boolean;
	message: Message | null;
	turnId: string | null;
};

/**
 * Understand a spoken line and post what the member most likely said as an ordinary message.
 *
 * The participant checks run before the paid model call. A replay by Idempotency-Key answers the earlier result with
 * `degraded` false and calls nothing. The understanding call's spend is recorded on its own ledger row under
 * `voice:<uuid>` whether or not anything is posted. A line with no message (filler only) posts nothing and starts no
 * turn.
 *
 * @throws ChannelNotFoundError If the channel is unknown.
 * @throws ChannelTenantMismatchError If the tenant does not own the channel.
 * @throws ActorNotInChannelError If the author or the addressed bot is not a participant.
 */
export async function postVoiceMessage(
	deps: VoiceMessageDependencies,
	request: VoiceMessageRequest,
): Promise<VoiceMessageResult> {
	const channel = await requireChannelTenant(request.channelId, request.tenantId, deps.messages);
	requireParticipant(channel, "human", request.authorId);
	requireParticipant(channel, "bot", request.addressedToBotId);
	if (request.idempotencyKey !== null) {
		const earlier = await deps.messages.store.getPostIdempotency(request.tenantId, request.idempotencyKey);
		if (earlier !== null) {
			return { understood: earlier.message.body, degraded: false, message: earlier.message, turnId: earlier.turnId };
		}
	}
	const recentAfter = Math.max(0, channel.nextSeq - 1 - RECENT_LINES_FOR_UNDERSTANDING);
	const recentMessages = (
		await listMessages(deps.messages, { tenantId: request.tenantId, channelId: request.channelId, afterSeq: recentAfter })
	).slice(-RECENT_LINES_FOR_UNDERSTANDING);
	const botNames = new Map((await deps.messages.store.listBots(request.tenantId)).map((bot) => [bot.botId, bot.name]));
	const recent: RecentLine[] = recentMessages.map((message) => ({
		speaker: message.authorKind === "bot" ? (botNames.get(message.authorId) ?? "Teammate") : "Person",
		text: message.body,
	}));
	const understanding = await understandOrTakeAsHeard(deps.understanding, request.transcript, recent);
	if (understanding.usage !== null) {
		try {
			await recordVendorSpend(deps.ledger, request.tenantId, `voice:${randomUUID()}`, understanding.usage, BILLED_VIA_VENDOR);
		} catch (error) {
			console.warn(
				`voice_understanding_spend_not_recorded tenant_id=${request.tenantId} error=${error instanceof Error ? error.name : typeof error}`,
			);
		}
	}
	const heardWordCount = wordCount(request.transcript);
	if (understanding.text === "") {
		console.log(
			`voice_line_understood heard_word_count=${heardWordCount} understood_word_count=0 outcome=${understanding.outcome} turn_id=none`,
		);
		return { understood: "", degraded: understanding.degraded, message: null, turnId: null };
	}
	const posted = await postMessage(deps.messages, {
		tenantId: request.tenantId,
		channelId: request.channelId,
		authorKind: "human",
		authorId: request.authorId,
		body: understanding.text,
		addressedToBotId: request.addressedToBotId,
		idempotencyKey: request.idempotencyKey,
	});
	console.log(
		`voice_line_understood heard_word_count=${heardWordCount} understood_word_count=${wordCount(understanding.text)} outcome=${understanding.outcome} turn_id=${posted.turnId ?? "none"}`,
	);
	return { understood: understanding.text, degraded: understanding.degraded, message: posted.message, turnId: posted.turnId };
}
