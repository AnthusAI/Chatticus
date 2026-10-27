import type { AutomationHints } from "../transport.ts";
import { normalizeEmailAddress } from "./email-addresses.ts";

/** The header our own outbound mail carries so that it is recognized if it ever comes back. */
export const OWN_ORIGIN_HEADER = "x-chatticus-origin";

/** One header of a parsed message: a lowercase name and the unfolded value. */
export interface HeaderEntry {
	readonly key: string;
	readonly value: string;
}

const NOREPLY_LOCAL_PARTS = /^(no-?reply|do-?not-?reply|donotreply)$/;
const BOUNCE_LOCAL_PARTS = /^(mailer-daemon|postmaster)$/;

function valuesOf(headers: readonly HeaderEntry[], name: string): string[] {
	return headers.filter((header) => header.key === name).map((header) => header.value.trim());
}

/**
 * Read the headers that mark mail as sent by a machine, a list or ourselves, as the booleans the automation filter honors.
 *
 * @param headers Every header of the message.
 * @param senderAddress The normalized From address.
 * @returns The automation hints.
 */
export function automationHintsFromHeaders(headers: readonly HeaderEntry[], senderAddress: string): AutomationHints {
	const present = (name: string): boolean => headers.some((header) => header.key === name);
	const first = (name: string): string | undefined => valuesOf(headers, name)[0];
	const senderLocalPart = normalizeEmailAddress(senderAddress).split("@")[0] ?? "";
	const autoSubmittedValue = first("auto-submitted")?.toLowerCase().split(/[;\s(]/)[0];
	const precedence = first("precedence")?.toLowerCase();
	const returnPath = first("return-path");
	const contentType = first("content-type")?.toLowerCase() ?? "";
	return {
		autoSubmitted:
			(autoSubmittedValue !== undefined && autoSubmittedValue !== "no") ||
			present("x-autoreply") ||
			present("x-autorespond") ||
			present("x-auto-response-suppress") ||
			NOREPLY_LOCAL_PARTS.test(senderLocalPart),
		bulkPrecedence: precedence === "bulk" || precedence === "junk" || precedence === "list",
		bounceReport:
			(returnPath !== undefined && (returnPath === "" || returnPath === "<>")) ||
			contentType.startsWith("multipart/report") ||
			contentType.includes("delivery-status") ||
			BOUNCE_LOCAL_PARTS.test(senderLocalPart),
		listMail: present("list-id") || present("list-unsubscribe") || precedence === "list",
		ownOrigin: present(OWN_ORIGIN_HEADER),
	};
}
