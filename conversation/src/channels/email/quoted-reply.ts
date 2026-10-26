const ATTRIBUTION_LEAD = /^(on|le|am|el|il|op)\s/i;
const ATTRIBUTION_TRAIL = /(wrote|a écrit|schrieb|escribió|ha scritto|schreef)\s*:\s*$/i;
const ORIGINAL_MESSAGE_MARKER = /^-{2,}\s*original message\s*-{2,}$/i;
const MAXIMUM_ATTRIBUTION_LINES = 3;
const MAXIMUM_SIGNATURE_LINES = 12;

const isBlank = (line: string): boolean => line.trim() === "";
const isQuoted = (line: string): boolean => line.trimStart().startsWith(">");

function lastContentIndex(lines: readonly string[]): number {
	let index = lines.length - 1;
	while (index >= 0 && isBlank(lines[index]!)) index -= 1;
	return index;
}

function withoutTrailingQuote(lines: string[]): string[] {
	const end = lastContentIndex(lines);
	if (end < 0 || !isQuoted(lines[end]!)) return lines;
	let start = end;
	while (start > 0 && (isQuoted(lines[start - 1]!) || isBlank(lines[start - 1]!))) start -= 1;
	while (isBlank(lines[start]!)) start += 1;
	let cut = start;
	let above = start - 1;
	while (above >= 0 && isBlank(lines[above]!)) above -= 1;
	if (above >= 0 && ATTRIBUTION_TRAIL.test(lines[above]!.trim())) {
		cut = above;
		for (let span = 1; span <= MAXIMUM_ATTRIBUTION_LINES && above - span + 1 >= 0; span += 1) {
			const joined = lines.slice(above - span + 1, above + 1).map((line) => line.trim()).join(" ");
			if (ATTRIBUTION_LEAD.test(joined)) {
				cut = above - span + 1;
				break;
			}
		}
	}
	return lines.slice(0, cut);
}

function withoutOriginalMessageBlock(lines: string[]): string[] {
	const marker = lines.findIndex((line) => ORIGINAL_MESSAGE_MARKER.test(line.trim()));
	return marker < 0 ? lines : lines.slice(0, marker);
}

function withoutSignature(lines: string[]): string[] {
	for (let index = lines.length - 1; index >= 0 && lines.length - index <= MAXIMUM_SIGNATURE_LINES + 1; index -= 1) {
		const line = lines[index]!;
		if (line === "-- " || line === "--") return lines.slice(0, index);
	}
	return lines;
}

/**
 * Remove the parts of a plain text reply that are not new: a trailing quoted block with its attribution line, an
 * original-message block, and a standard signature. The stripping is conservative. A quote with anything written below it
 * (an inline reply) is kept whole, a signature is cut only at the standard delimiter line and only when it is short, and a
 * message that would be left empty is returned unchanged. The unmodified original is always kept by the raw mail archive.
 *
 * @param text The decoded plain text of the message.
 * @returns The new text of the message.
 */
export function stripQuotedReplyAndSignature(text: string): string {
	const original = text.replace(/\r\n?/g, "\n");
	let lines = original.split("\n");
	for (let pass = 0; pass < 3; pass += 1) {
		const before = lines.length;
		lines = withoutSignature(withoutTrailingQuote(withoutOriginalMessageBlock(lines)));
		if (lines.length === before) break;
	}
	const stripped = lines.join("\n").trim();
	return stripped === "" ? original.trim() : stripped;
}
