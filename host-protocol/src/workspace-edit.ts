/** What one exact edit of a file's text answered: the new text, or the message the model reads. */
export type ExactEditResult = { readonly ok: true; readonly content: string } | { readonly ok: false; readonly message: string };

const detectLineEnding = (content: string): "\r\n" | "\n" => {
	const lineFeed = content.indexOf("\n");
	if (lineFeed === -1) return "\n";
	const carriageReturnLineFeed = content.indexOf("\r\n");
	return carriageReturnLineFeed !== -1 && carriageReturnLineFeed < lineFeed ? "\r\n" : "\n";
};

const normalizeToLineFeed = (text: string): string => text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

/**
 * Replace exactly one occurrence of one text in a file's content, with the semantics of the edit tool of Pi: the old
 * text must match exactly, including whitespace and newlines; it must occur once; a replacement that changes nothing is
 * refused. The byte order mark and the line ending style of the file are kept. The messages are those of Pi.
 *
 * Pi's own routine is not exported by its package and also matches fuzzily (quotes, dashes, trailing spaces), which a
 * model that must see its edit fail should not get silently, so this is the exact-match part of it.
 *
 * @param content The current text of the file.
 * @param oldText The text to replace.
 * @param newText The text to put in its place.
 * @param path The path to name in messages.
 */
export function applyExactEdit(content: string, oldText: string, newText: string, path: string): ExactEditResult {
	const bom = content.startsWith("﻿") ? "﻿" : "";
	const body = bom === "" ? content : content.slice(1);
	const lineEnding = detectLineEnding(body);
	const normalizedContent = normalizeToLineFeed(body);
	const normalizedOld = normalizeToLineFeed(oldText);
	const normalizedNew = normalizeToLineFeed(newText);
	if (normalizedOld.length === 0) {
		return { ok: false, message: `old_text must not be empty in ${path}.` };
	}
	const occurrences = normalizedContent.split(normalizedOld).length - 1;
	if (occurrences === 0) {
		return {
			ok: false,
			message: `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
		};
	}
	if (occurrences > 1) {
		return {
			ok: false,
			message: `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
		};
	}
	const index = normalizedContent.indexOf(normalizedOld);
	const edited = normalizedContent.slice(0, index) + normalizedNew + normalizedContent.slice(index + normalizedOld.length);
	if (edited === normalizedContent) {
		return {
			ok: false,
			message: `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		};
	}
	return { ok: true, content: bom + (lineEnding === "\r\n" ? edited.replace(/\n/g, "\r\n") : edited) };
}
