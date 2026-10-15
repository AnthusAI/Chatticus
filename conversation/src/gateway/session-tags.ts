/** One STS session tag, in the shape the `Tags` parameter of AssumeRole takes. */
export type SessionTag = {
	readonly Key: string;
	readonly Value: string;
};

/** The ids a computer owner's storage credentials are bound to. */
export type OwnerSessionScope = {
	readonly tenantId: string;
	readonly botId: string;
	readonly channelId: string;
	readonly computerId: string;
	readonly turnId: string;
};

/**
 * The session tag keys, in the order they are sent. The role's static permission policy reads `tenant`, `bot`, `channel` and
 * `computer` as `${aws:PrincipalTag/<key>}`; `turn` rides along so CloudTrail records which turn a credential was minted for.
 * The role's trust policy refuses a session that lacks any of them or carries any other key.
 */
export const OWNER_SESSION_TAG_KEYS = ["tenant", "bot", "channel", "computer", "turn"] as const;

/**
 * The characters an id may contain to become a tag value: the letters, digits, `_`, `.`, `:` and `-` of the ids the platform
 * generates. AWS would also accept space, `/`, `=`, `+` and `@`; none of those occurs in an id, and refusing them keeps a tag
 * value from ever acting as a wildcard, a key separator (`#`) or an escape (`%`) inside the policy that embeds it.
 */
const SAFE_TAG_VALUE = /^[A-Za-z0-9_.:-]+$/;

/** The most characters AWS accepts in one tag value. */
const TAG_VALUE_MAXIMUM_CHARACTERS = 256;

/** An id cannot become a session tag value, so no credentials are minted. */
export class OwnerSessionTagError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OwnerSessionTagError";
	}
}

/**
 * The session tags that confine a computer owner's credentials to one conversation session and one computer: the role's
 * static policy substitutes them into its resources and key conditions.
 *
 * Nothing is dropped or rewritten: an id outside the safe set, empty, or longer than a tag value may be, is refused.
 *
 * @param scope The organization, bot, channel, computer and turn of the owner.
 * @returns The five tags, in key order.
 * @throws OwnerSessionTagError When an id cannot be a tag value.
 */
export function ownerSessionTags(scope: OwnerSessionScope): SessionTag[] {
	const values: Record<(typeof OWNER_SESSION_TAG_KEYS)[number], string> = {
		tenant: scope.tenantId,
		bot: scope.botId,
		channel: scope.channelId,
		computer: scope.computerId,
		turn: scope.turnId,
	};
	return OWNER_SESSION_TAG_KEYS.map((key) => safeTag(key, values[key]));
}

function safeTag(key: string, value: string): SessionTag {
	if (!SAFE_TAG_VALUE.test(value) || value.length > TAG_VALUE_MAXIMUM_CHARACTERS) {
		throw new OwnerSessionTagError(
			`The ${key} id ${JSON.stringify(value)} cannot be a session tag value (letters, digits, "_", ".", ":" and "-", at most ${TAG_VALUE_MAXIMUM_CHARACTERS} characters), so no owner credentials were minted.`,
		);
	}
	return { Key: key, Value: value };
}

/** The ids a computer supervisor's snapshot credentials are bound to: the organization and its one computer, nothing finer. */
export type SupervisorSessionScope = {
	readonly tenantId: string;
	readonly computerId: string;
};

/**
 * The session tag keys of the supervisor role, in the order they are sent. The role's static policy reads both as
 * `${aws:PrincipalTag/<key>}` in its snapshot prefix; its trust policy refuses a session that lacks either or carries another key.
 */
export const SUPERVISOR_SESSION_TAG_KEYS = ["tenant", "computer"] as const;

/**
 * The session tags that confine the supervisor's credentials to the snapshot prefix of one computer of one organization.
 * The same value rules as {@link ownerSessionTags} apply; nothing is dropped or rewritten.
 *
 * Phase 2a: the broker builds these for `purpose: supervisor`, and the starter calls this before it starts a task so an unsafe
 * id stops the start early.
 *
 * @param scope The organization and the computer.
 * @returns The two tags, in key order.
 * @throws OwnerSessionTagError When an id cannot be a tag value.
 */
export function supervisorSessionTags(scope: SupervisorSessionScope): SessionTag[] {
	const values: Record<(typeof SUPERVISOR_SESSION_TAG_KEYS)[number], string> = { tenant: scope.tenantId, computer: scope.computerId };
	return SUPERVISOR_SESSION_TAG_KEYS.map((key) => safeTag(key, values[key]));
}
