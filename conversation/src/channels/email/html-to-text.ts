const NAMED_ENTITIES: Readonly<Record<string, string>> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	copy: "©",
	reg: "®",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	bull: "•",
	middot: "·",
	euro: "€",
	pound: "£",
	yen: "¥",
	eacute: "é",
};

const LINE_BREAK = "\u0002";
const PARAGRAPH_BREAK = "\u0003";
const QUOTE_OPEN_MARKER = "\u0001quote-open\u0001";
const QUOTE_CLOSE_MARKER = "\u0001quote-close\u0001";

function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body: string) => {
		if (body.startsWith("#")) {
			const codePoint = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
			const printable = Number.isInteger(codePoint) && codePoint > 31 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff);
			return printable || codePoint === 9 || codePoint === 10 ? String.fromCodePoint(codePoint) : "";
		}
		return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
	});
}

function withQuotePrefixes(text: string): string {
	let depth = 0;
	const lines: string[] = [];
	for (const line of text.split("\n")) {
		if (line === QUOTE_OPEN_MARKER) depth += 1;
		else if (line === QUOTE_CLOSE_MARKER) depth = Math.max(0, depth - 1);
		else lines.push(depth === 0 ? line : line === "" ? ">".repeat(depth) : `${">".repeat(depth)} ${line}`);
	}
	return lines.join("\n");
}

/**
 * Convert an HTML email body to readable plain text without any network access. Scripts, styles, comments and every image
 * are dropped, so a tracking pixel or a remote image is never mentioned, let alone fetched. Links keep their address in
 * parentheses, list items become dashes, block elements become lines, and quoted blocks become lines starting with a
 * greater-than sign so the quoted reply stripper treats them like quoted plain text.
 *
 * @param html The HTML part of the message, already decoded to text.
 * @returns Plain text with no more than one blank line in a row.
 */
export function htmlToText(html: string): string {
	let working = html
		.replace(/[\u0001-\u0003]/g, "")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(script|style|head|title|svg|object|iframe|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
		.replace(/<(img|link|meta|embed|input)\b[^>]*>/gi, " ")
		.replace(/\s+/g, " ");
	working = working.replace(/<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi, (_whole, quoted: string | undefined, apostrophed: string | undefined, bare: string | undefined, inner: string) => {
		const href = decodeEntities((quoted ?? apostrophed ?? bare ?? "").trim());
		const visible = decodeEntities(inner.replace(/<[^>]*>/g, "")).trim();
		if (!/^https?:\/\//i.test(href) || visible === href) return inner;
		return visible === "" ? href : `${inner} (${href})`;
	});
	working = working
		.replace(/<blockquote\b[^>]*>/gi, `\n${QUOTE_OPEN_MARKER}\n`)
		.replace(/<\/blockquote\s*>/gi, `\n${QUOTE_CLOSE_MARKER}\n`)
		.replace(/<li\b[^>]*>/gi, `${LINE_BREAK}- `)
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/?(p|h[1-6]|hr|ul|ol|table)\b[^>]*>/gi, PARAGRAPH_BREAK)
		.replace(/<\/?(div|tr|section|article|header|footer|center|pre)\b[^>]*>/gi, LINE_BREAK)
		.replace(/<\/(td|th)\s*>/gi, " ")
		.replace(/<\/?[a-zA-Z][^>]*>/g, "")
		.replace(/[\u0002\u0003 ]*[\u0002\u0003][\u0002\u0003 ]*/g, (run) => (run.includes(PARAGRAPH_BREAK) ? "\n\n" : "\n"));
	const decoded = decodeEntities(working);
	const lines = decoded.split("\n").map((line) => (line === QUOTE_OPEN_MARKER || line === QUOTE_CLOSE_MARKER ? line : line.replace(/[ \t ]+/g, " ").trim()));
	return withQuotePrefixes(lines.join("\n"))
		.replace(/\n{3,}/g, "\n\n")
		.trim()
		.replace(/(\n>+)+$/, "")
		.trim();
}
