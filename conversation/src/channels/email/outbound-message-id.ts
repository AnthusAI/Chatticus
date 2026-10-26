import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeMessageId } from "./email-addresses.ts";

const TOKEN_CHARACTERS = 20;
const MARK_CHARACTERS = 12;
const LOCAL_PART_PATTERN = /^chatticus\.([0-9a-f]{20})\.([0-9a-f]{12})$/;

const keyedHex = (secret: string, purpose: string, input: string, characters: number): string =>
	createHmac("sha256", secret).update(JSON.stringify([purpose, input])).digest("hex").slice(0, characters);

/**
 * The Message-ID of an outbound reply, without angle brackets: `chatticus.<token>.<mark>@<mail domain>`. The token is a
 * keyed hash of the reply and the binding, so rendering the same reply twice gives the same id; the mark is a keyed hash
 * of the token, so only a holder of the secret can make an id that is recognized as ours.
 *
 * @param secret The deployment's correlator secret.
 * @param mailDomain The environment's mail domain.
 * @param reply The organization, the committed message and the binding the reply belongs to.
 * @returns The normalized Message-ID.
 */
export function outboundMessageId(secret: string, mailDomain: string, reply: { tenantId: string; messageId: string; bindingId: string }): string {
	const token = keyedHex(secret, "outbound-message-token", JSON.stringify([reply.tenantId, reply.messageId, reply.bindingId]), TOKEN_CHARACTERS);
	const mark = keyedHex(secret, "outbound-message-mark", token, MARK_CHARACTERS);
	return `chatticus.${token}.${mark}@${mailDomain.trim().toLowerCase()}`;
}

/**
 * Whether a Message-ID is one this deployment produced: on its mail domain, in our format, with a mark that verifies.
 *
 * @param secret The deployment's correlator secret.
 * @param mailDomain The environment's mail domain.
 * @param messageId A Message-ID as a header carried it, with or without angle brackets.
 * @returns True only for an id made by `outboundMessageId` under this secret.
 */
export function isOwnOutboundMessageId(secret: string, mailDomain: string, messageId: string): boolean {
	const normalized = normalizeMessageId(messageId);
	if (normalized === null) return false;
	const at = normalized.lastIndexOf("@");
	if (at <= 0 || normalized.slice(at + 1) !== mailDomain.trim().toLowerCase()) return false;
	const parts = LOCAL_PART_PATTERN.exec(normalized.slice(0, at));
	if (parts === null) return false;
	const expected = Buffer.from(keyedHex(secret, "outbound-message-mark", parts[1]!, MARK_CHARACTERS));
	const offered = Buffer.from(parts[2]!);
	return expected.length === offered.length && timingSafeEqual(expected, offered);
}
