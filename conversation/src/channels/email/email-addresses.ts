/** The longest message id the adapter will keep; the mail standard limits a header line to 998 characters. */
export const MAXIMUM_MESSAGE_ID_CHARACTERS = 998;

/** The most earlier message ids one inbound message may bring into the conversation lookup. */
export const MAXIMUM_REFERENCED_MESSAGE_IDS = 50;

/**
 * An email address as it is compared everywhere: trimmed, without angle brackets, lowercase.
 *
 * @param address The address as a header carried it.
 * @returns The normalized address.
 */
export function normalizeEmailAddress(address: string): string {
	return address.trim().replace(/^<|>$/g, "").trim().toLowerCase();
}

/** An address split into the part that routes and the plus tag that may follow its local part. */
export interface SplitPlusTag {
	readonly routeAddress: string;
	readonly tag: string | null;
}

/**
 * Split `bot+tag@domain` into `bot@domain` and `tag`. The tag is everything after the first plus sign of the local part.
 *
 * @param address A normalized address.
 * @returns The address without its tag, and the tag or null.
 */
export function splitPlusTag(address: string): SplitPlusTag {
	const at = address.lastIndexOf("@");
	if (at <= 0) return { routeAddress: address, tag: null };
	const localPart = address.slice(0, at);
	const plus = localPart.indexOf("+");
	if (plus < 0) return { routeAddress: address, tag: null };
	const tag = localPart.slice(plus + 1);
	return { routeAddress: `${localPart.slice(0, plus)}${address.slice(at)}`, tag: tag === "" ? null : tag };
}

/**
 * A message id as it is compared and stored: without angle brackets, lowercase, with no whitespace.
 *
 * @param value One message id as a header carried it.
 * @returns The normalized id, or null when nothing usable remains.
 */
export function normalizeMessageId(value: string): string | null {
	const stripped = value.trim().replace(/^<|>$/g, "").trim().toLowerCase();
	if (stripped === "" || stripped.length > MAXIMUM_MESSAGE_ID_CHARACTERS || /\s/.test(stripped)) return null;
	return stripped;
}

/**
 * Every message id in a References or In-Reply-To header value, in header order, without duplicates. Ids inside angle
 * brackets win; a header without brackets is read as whitespace separated ids.
 *
 * @param headerValue The raw header value, or undefined when the header is absent.
 * @returns The normalized ids.
 */
export function messageIdsOfHeader(headerValue: string | undefined): string[] {
	if (headerValue === undefined) return [];
	const bracketed = [...headerValue.matchAll(/<([^<>]*)>/g)].map((match) => match[1] ?? "");
	const candidates = bracketed.length > 0 ? bracketed : headerValue.split(/\s+/);
	const ids: string[] = [];
	for (const candidate of candidates) {
		const id = normalizeMessageId(candidate);
		if (id !== null && !ids.includes(id)) ids.push(id);
	}
	return ids;
}

/**
 * The earlier messages a reply names, nearest first: the in-reply-to message, then the references from the newest back to
 * the root. A very long chain keeps its nearest entries and its root.
 *
 * @param inReplyTo The ids of the In-Reply-To header.
 * @param references The ids of the References header, root first.
 * @param ownMessageId The message's own id, which is never its own ancestor.
 * @returns The ids to look up, nearest first.
 */
export function ancestorMessageIds(inReplyTo: readonly string[], references: readonly string[], ownMessageId: string): string[] {
	const ordered: string[] = [];
	for (const id of [...inReplyTo.slice(0, 1), ...[...references].reverse()]) {
		if (id !== ownMessageId && !ordered.includes(id)) ordered.push(id);
	}
	if (ordered.length <= MAXIMUM_REFERENCED_MESSAGE_IDS) return ordered;
	return [...ordered.slice(0, MAXIMUM_REFERENCED_MESSAGE_IDS - 1), ordered[ordered.length - 1]!];
}

/**
 * The key of an email thread: the first reference, else the in-reply-to message, else the message itself.
 *
 * @param inReplyTo The ids of the In-Reply-To header.
 * @param references The ids of the References header, root first.
 * @param ownMessageId The message's own id.
 * @returns The conversation key.
 */
export function emailConversationKey(inReplyTo: readonly string[], references: readonly string[], ownMessageId: string): string {
	return references[0] ?? inReplyTo[0] ?? ownMessageId;
}
