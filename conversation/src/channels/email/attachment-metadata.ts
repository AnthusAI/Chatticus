const MAXIMUM_FILE_NAME_CHARACTERS = 255;
const MAXIMUM_CONTENT_TYPE_CHARACTERS = 255;
const CONTENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/** The content type recorded for an attachment whose declared type is not a valid media type. */
export const UNKNOWN_CONTENT_TYPE = "application/octet-stream";

/**
 * An attachment file name made safe to record and later show or save: directory parts removed, control characters
 * (including NUL) removed, surrounding whitespace trimmed, and the length capped.
 *
 * @param declared The name the sender's mail client declared, or null.
 * @returns The cleaned base name; empty when nothing usable remains.
 */
export function sanitizedAttachmentFileName(declared: string | null): string {
	if (declared === null) return "";
	const withoutControls = declared.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
	const baseName = withoutControls.split(/[\\/]/).pop() ?? "";
	const cleaned = baseName.trim();
	return cleaned === "." || cleaned === ".." ? "" : cleaned.slice(0, MAXIMUM_FILE_NAME_CHARACTERS);
}

/**
 * An attachment media type made safe to record: lowercase, control characters removed, and replaced by the generic binary
 * type when it is not a well formed `type/subtype`.
 *
 * @param declared The media type the sender's mail client declared.
 * @returns The cleaned media type.
 */
export function sanitizedContentType(declared: string): string {
	const cleaned = declared.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().toLowerCase().slice(0, MAXIMUM_CONTENT_TYPE_CHARACTERS);
	return CONTENT_TYPE_PATTERN.test(cleaned) ? cleaned : UNKNOWN_CONTENT_TYPE;
}
