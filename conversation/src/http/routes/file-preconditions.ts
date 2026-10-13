import { MemberFileRefusal } from "../../domain/member-file-refusal.ts";

/** What a save must find: the hash a person last saw, or nothing at all (a create). */
export type WritePrecondition = { readonly type: "if_match"; readonly sha256: string } | { readonly type: "if_none_match" };

const STRONG_QUOTED_SHA256 = /^"([0-9a-f]{64})"$/;

/**
 * Read the precondition of a save from its headers (section 6.2). Exactly one of the two must be present: neither, or both,
 * is 428. `If-Match` takes one strong quoted 64 hex digit value, never `*`, a list or a weak value; `If-None-Match` takes `*`
 * only. Anything else is 400.
 *
 * @param ifMatch The `If-Match` header, or undefined.
 * @param ifNoneMatch The `If-None-Match` header, or undefined.
 * @returns The precondition.
 * @throws MemberFileRefusal `precondition_required` (428) or `invalid_body` (400).
 */
export function writePreconditionOf(ifMatch: string | undefined, ifNoneMatch: string | undefined): WritePrecondition {
	if ((ifMatch === undefined) === (ifNoneMatch === undefined)) {
		throw new MemberFileRefusal("precondition_required", "A save needs exactly one of If-Match and If-None-Match.");
	}
	if (ifNoneMatch !== undefined) {
		if (ifNoneMatch.trim() !== "*") throw new MemberFileRefusal("invalid_body", "If-None-Match takes * only.");
		return { type: "if_none_match" };
	}
	const matched = STRONG_QUOTED_SHA256.exec((ifMatch ?? "").trim());
	if (matched === null) throw new MemberFileRefusal("invalid_body", 'If-Match takes one strong quoted SHA-256, like "<64 hex digits>".');
	return { type: "if_match", sha256: matched[1]! };
}
