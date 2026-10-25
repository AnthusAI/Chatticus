/** Words an organization may not choose as its mail handle: they are infrastructure or operator names. */
export const RESERVED_MAIL_HANDLES: readonly string[] = [
	"abuse",
	"admin",
	"api",
	"auth",
	"hey",
	"mail",
	"postmaster",
	"root",
	"support",
	"www",
];

const DNS_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Why a proposed mail handle is not acceptable, or null when it is. */
export type MailHandleProblem = "not_a_dns_label" | "reserved";

/**
 * Check a proposed organization mail handle: a lowercase DNS label that is not a reserved word.
 *
 * @param handle The proposal, already lowercased by the caller.
 * @returns The problem, or null when the handle is acceptable.
 */
export function mailHandleProblem(handle: string): MailHandleProblem | null {
	if (!DNS_LABEL_PATTERN.test(handle)) return "not_a_dns_label";
	if (RESERVED_MAIL_HANDLES.includes(handle)) return "reserved";
	return null;
}

/**
 * The local part a bot answers to, derived from its unique name: lowercase letters and digits, with every other run of
 * characters becoming one hyphen.
 *
 * @param botName The bot's name.
 * @returns The local part; empty when the name has no letter or digit.
 */
export function botMailLocalPart(botName: string): string {
	return botName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

/**
 * The email address of a bot: `<bot>@<handle>.<mail domain>`.
 *
 * @param botName The bot's name.
 * @param mailHandle The organization's mail handle.
 * @param mailDomain The environment's mail domain.
 * @returns The address, or null when the bot name yields no local part.
 */
export function botMailAddress(botName: string, mailHandle: string, mailDomain: string): string | null {
	const localPart = botMailLocalPart(botName);
	return localPart === "" ? null : `${localPart}@${mailHandle}.${mailDomain}`;
}
