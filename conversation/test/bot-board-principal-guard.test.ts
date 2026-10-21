import { describe, expect, it } from "vitest";
import { MembershipCache } from "../src/auth/membership-cache.ts";
import { PrincipalHttpError, resolvePrincipal, type CachedMembership, type PrincipalDirectory } from "../src/auth/principal.ts";

const BOARD_PATHS = [
	"/orgs/anthus/bots/bot-1/board",
	"/orgs/anthus/bots/bot-1/board/cards",
	"/orgs/anthus/bots/bot-1/board/cards/kanbus-1",
	"/orgs/anthus/bots/bot-1/board/cards/kanbus-1/dependencies/kanbus-2",
	"/orgs/anthus/bots/bot-1/board/archive",
];

function directoryWithoutMembership(): PrincipalDirectory {
	return {
		getIdentityByEmail: async () => ({ userId: "stranger" }),
		getMembership: async () => null,
		getOrganizationStatus: async () => "enabled",
		verifyWorkerToken: async () => null,
	};
}

describe("the principal layer that every board route relies on to refuse non-members", () => {
	it.each(BOARD_PATHS)("refuses a signed-in non-member of the organization at %s and names the user", async (path) => {
		const request = new Request(`http://front-door.test${path}`, { headers: { Authorization: "Bearer token" } });
		const refusal = resolvePrincipal(request, {
			verifier: { verifyIdToken: async () => ({ email: "stranger@example.org" }) } as never,
			directory: directoryWithoutMembership(),
			membershipCache: new MembershipCache<CachedMembership>({ nowMilliseconds: () => 0 }),
			requireEnabledMember: true,
		});
		await expect(refusal).rejects.toBeInstanceOf(PrincipalHttpError);
		await expect(refusal).rejects.toMatchObject({ status: 403, nonMemberUserId: "stranger" });
	});
});
