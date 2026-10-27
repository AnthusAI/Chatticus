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

const QUOTE_OPEN_MARKER = "\u0001quote-open\u0001";
const QUOTE_CLOSE_MARKER = "\u0001quote-close\u0001";

/** The most HTML the converter reads; anything beyond it is ignored. */
export const MAXIMUM_HTML_CHARACTERS = 1_000_000;

const MAXIMUM_TAG_CHARACTERS = 4096;
const MAXIMUM_OPEN_LINKS = 64;
const MAXIMUM_QUOTE_DEPTH = 8;

const SKIPPED_ELEMENTS: ReadonlySet<string> = new Set(["script", "style", "head", "title", "svg", "object", "iframe", "template"]);
const DROPPED_TAGS: ReadonlySet<string> = new Set(["img", "link", "meta", "embed", "input"]);
const PARAGRAPH_TAGS: ReadonlySet<string> = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "ul", "ol", "table"]);
const LINE_TAGS: ReadonlySet<string> = new Set(["div", "tr", "section", "article", "header", "footer", "center", "pre"]);
const HREF_PATTERN = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

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

function indexOfTagEnd(source: string, start: number): number {
	let quote = "";
	let previousSignificant = "";
	for (let index = start; index < source.length; index += 1) {
		const character = source[index]!;
		if (quote !== "") {
			if (character === quote) quote = "";
			continue;
		}
		if (character === ">") return index;
		if ((character === '"' || character === "'") && previousSignificant === "=") quote = character;
		if (character !== " " && character !== "\t" && character !== "\n" && character !== "\r" && character !== "\f") previousSignificant = character;
	}
	return -1;
}

function withQuotePrefixes(text: string): string {
	let depth = 0;
	const lines: string[] = [];
	for (const line of text.split("\n")) {
		if (line === QUOTE_OPEN_MARKER) depth = Math.min(MAXIMUM_QUOTE_DEPTH, depth + 1);
		else if (line === QUOTE_CLOSE_MARKER) depth = Math.max(0, depth - 1);
		else lines.push(depth === 0 ? line : line === "" ? ">".repeat(depth) : `${">".repeat(depth)} ${line}`);
	}
	return lines.join("\n");
}

/**
 * Convert an HTML email body to readable plain text without any network access, in one linear pass. Input beyond one
 * million characters is ignored. Scripts, styles, comments and every image are dropped, so a tracking pixel or a remote
 * image is never mentioned, let alone fetched. Links keep their address in parentheses, list items become dashes, block
 * elements become lines, and quoted blocks become lines starting with a greater-than sign so the quoted reply stripper
 * treats them like quoted plain text. A closing angle bracket inside a quoted attribute value does not end the tag. A tag that is never closed, or a comment or script that never ends, drops the rest
 * of the document instead of being searched for again.
 *
 * @param html The HTML part of the message, already decoded to text.
 * @returns Plain text with no more than one blank line in a row.
 */
export function htmlToText(html: string): string {
	const source = html.slice(0, MAXIMUM_HTML_CHARACTERS).replace(/[\u0001-\u0003]/g, "");
	const lowered = source.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
	const parts: string[] = [];
	let outputLength = 0;
	let lastCharacter = "";
	let pendingBreak = 0;
	const openLinks: Array<{ href: string; partStart: number }> = [];

	const emit = (piece: string): void => {
		if (piece === "") return;
		parts.push(piece);
		outputLength += piece.length;
		lastCharacter = piece[piece.length - 1]!;
	};
	const atLineStart = (): boolean => outputLength === 0 || lastCharacter === " " || lastCharacter === "\n";
	const flushBreak = (): void => {
		if (pendingBreak > 0 && outputLength > 0) emit("\n".repeat(pendingBreak));
		pendingBreak = 0;
	};
	const appendText = (raw: string): void => {
		let text = decodeEntities(raw.replace(/\s+/g, " "));
		if (text === "" || text === " ") {
			if (text === " " && pendingBreak === 0 && !atLineStart()) emit(" ");
			return;
		}
		flushBreak();
		if (atLineStart()) text = text.replace(/^ /, "");
		emit(text);
	};
	const requestBreak = (lines: number): void => {
		pendingBreak = Math.max(pendingBreak, lines);
	};

	let position = 0;
	while (position < source.length) {
		const open = source.indexOf("<", position);
		if (open < 0) {
			appendText(source.slice(position));
			break;
		}
		if (open > position) appendText(source.slice(position, open));
		const next = source[open + 1] ?? "";
		if (!/[a-zA-Z/!]/.test(next)) {
			appendText("<");
			position = open + 1;
			continue;
		}
		if (source.startsWith("<!--", open)) {
			const end = source.indexOf("-->", open + 4);
			if (end < 0) break;
			position = end + 3;
			continue;
		}
		const close = indexOfTagEnd(source, open + 1);
		if (close < 0) break;
		position = close + 1;
		const tagText = source.slice(open + 1, Math.min(close, open + 1 + MAXIMUM_TAG_CHARACTERS));
		const nameMatch = /^(\/?)([a-zA-Z][a-zA-Z0-9]*)/.exec(tagText);
		if (nameMatch === null) continue;
		const closing = nameMatch[1] === "/";
		const name = nameMatch[2]!.toLowerCase();
		if (SKIPPED_ELEMENTS.has(name)) {
			if (closing) continue;
			const end = lowered.indexOf(`</${name}`, position);
			if (end < 0) break;
			const endClose = source.indexOf(">", end);
			if (endClose < 0) break;
			position = endClose + 1;
			continue;
		}
		if (DROPPED_TAGS.has(name)) continue;
		if (name === "blockquote") {
			flushBreak();
			emit(`\n${closing ? QUOTE_CLOSE_MARKER : QUOTE_OPEN_MARKER}\n`);
			continue;
		}
		if (name === "a") {
			if (!closing) {
				const hrefMatch = HREF_PATTERN.exec(tagText);
				const href = decodeEntities((hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? "").trim());
				if (/^https?:\/\//i.test(href) && openLinks.length < MAXIMUM_OPEN_LINKS) openLinks.push({ href, partStart: parts.length });
			} else {
				const link = openLinks.pop();
				if (link !== undefined) {
					const visible = parts.slice(link.partStart).join("").trim();
					if (visible === "") emit(link.href);
					else if (visible !== link.href) emit(` (${link.href})`);
				}
			}
			continue;
		}
		if (name === "br") {
			flushBreak();
			emit("\n");
		} else if (name === "li") {
			if (!closing) {
				requestBreak(1);
				appendText("- ");
			}
		} else if (PARAGRAPH_TAGS.has(name)) requestBreak(2);
		else if (LINE_TAGS.has(name)) requestBreak(1);
		else if (name === "td" || name === "th") {
			if (closing) appendText(" ");
		}
	}

	const lines = parts.join("").split("\n").map((line) => (line === QUOTE_OPEN_MARKER || line === QUOTE_CLOSE_MARKER ? line : line.replace(/[ \t\u00a0]+/g, " ").trim()));
	return withQuotePrefixes(lines.join("\n"))
		.replace(/\n{3,}/g, "\n\n")
		.trim()
		.replace(/(\n>+)+$/, "")
		.trim();
}
