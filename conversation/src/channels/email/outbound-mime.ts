const MAXIMUM_SUBJECT_CHARACTERS = 200;
const ENCODED_WORD_SOURCE_BYTES = 30;
const BASE64_LINE_CHARACTERS = 76;

/** The subject of a reply whose thread has no subject. */
export const DEFAULT_REPLY_SUBJECT = "Re: your message";

const REPLY_PREFIX = /^(?:\s*re\s*(?:\[\d+\])?\s*:)+\s*/i;

/**
 * Text that is safe inside one header line: control characters, including line breaks, become spaces and runs of
 * whitespace collapse, so a value can never end its own header and start another.
 *
 * @param value Any text.
 * @returns The text on one line.
 */
export function singleLineHeaderText(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The subject of a reply: the thread's subject on one line, with every leading Re prefix replaced by exactly one.
 *
 * @param threadSubject The subject the thread started with, or null when it has none.
 * @returns The reply subject.
 */
export function replySubject(threadSubject: string | null): string {
	const bare = singleLineHeaderText(threadSubject ?? "").replace(REPLY_PREFIX, "").trim().slice(0, MAXIMUM_SUBJECT_CHARACTERS).trim();
	return bare === "" ? DEFAULT_REPLY_SUBJECT : `Re: ${bare}`;
}

/**
 * A header value as it travels: plain when it is printable ASCII, otherwise a sequence of RFC 2047 encoded words that
 * never splits a character.
 *
 * @param value A single line value.
 * @returns The value ready for a header line; encoded words are joined with a folding space.
 */
export function encodedHeaderValue(value: string): string {
	if (/^[ -~]*$/.test(value)) return value;
	const words: string[] = [];
	let current = Buffer.alloc(0);
	for (const character of value) {
		const bytes = Buffer.from(character, "utf8");
		if (current.length + bytes.length > ENCODED_WORD_SOURCE_BYTES) {
			words.push(`=?UTF-8?B?${current.toString("base64")}?=`);
			current = Buffer.alloc(0);
		}
		current = Buffer.concat([current, bytes]);
	}
	if (current.length > 0) words.push(`=?UTF-8?B?${current.toString("base64")}?=`);
	return words.join("\r\n ");
}

/** The longest message id kept in an In-Reply-To or References header. */
export const MAXIMUM_HEADER_MESSAGE_ID_CHARACTERS = 450;

/** The most characters the ids of one References header may take together, so the line stays under the 998 character limit. */
export const MAXIMUM_REFERENCES_CHARACTERS = 900;

const HEADER_MESSAGE_ID_PATTERN = /^[\x21-\x3b\x3d\x3f\x41-\x7e]+@[\x21-\x3b\x3d\x3f\x41-\x7e]+$/;

/**
 * Whether an id can be written into a threading header: one id of printable ASCII with a single at sign, no angle
 * brackets or whitespace, and within the length limit.
 *
 * @param messageId A normalized message id without angle brackets.
 * @returns True when the id is safe and small enough to send.
 */
export function isUsableHeaderMessageId(messageId: string): boolean {
	return messageId.length <= MAXIMUM_HEADER_MESSAGE_ID_CHARACTERS && HEADER_MESSAGE_ID_PATTERN.test(messageId);
}

/**
 * The ids of a References header: the usable ones only, oldest first, with the oldest dropped until the header fits.
 * The newest id, the one answered, is kept whenever it is usable.
 *
 * @param ids The thread's ids, oldest first.
 * @returns The ids to write.
 */
export function referencesHeaderIds(ids: readonly string[]): string[] {
	const usable = [...new Set(ids.filter(isUsableHeaderMessageId))];
	while (usable.length > 1 && usable.reduce((total, id) => total + id.length + 3, 0) > MAXIMUM_REFERENCES_CHARACTERS) usable.shift();
	return usable;
}

/** The headers and body of one outbound message; header values are plain text and are encoded when written. */
export interface OutboundMimeMessage {
	readonly headers: ReadonlyArray<readonly [name: string, value: string]>;
	readonly subject: string;
	readonly text: string;
}

/**
 * Write a plain text message as bytes: single line headers, a UTF-8 text part, and the body in base64 so no line length
 * or character set limit can corrupt it.
 *
 * @param message The headers, subject and body.
 * @returns The raw message for SES.
 */
export function outboundMimeBytes(message: OutboundMimeMessage): Uint8Array {
	const lines: string[] = [];
	for (const [name, value] of message.headers) lines.push(`${name}: ${encodedHeaderValue(singleLineHeaderText(value))}`);
	lines.push(`Subject: ${encodedHeaderValue(singleLineHeaderText(message.subject))}`);
	lines.push("MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64");
	const body = Buffer.from(message.text.replace(/\r\n|\r|\n/g, "\r\n"), "utf8").toString("base64");
	const bodyLines = body.match(new RegExp(`.{1,${BASE64_LINE_CHARACTERS}}`, "g")) ?? [];
	return Buffer.from(`${lines.join("\r\n")}\r\n\r\n${bodyLines.join("\r\n")}\r\n`, "latin1");
}
