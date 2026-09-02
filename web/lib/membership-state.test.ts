import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { VerifiedSession } from "./auth";
import type { MeResponse } from "./me";
import { deriveMembershipBranch, pickActiveOrg } from "./membership-state";

const session: VerifiedSession = {
  idToken: "token",
  claims: { email: "owner@example.com" },
  email: "owner@example.com",
};

function me(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    email: "owner@example.com",
    user_id: "user-1",
    organizations: [],
    ...overrides,
  };
}

describe("deriveMembershipBranch", () => {
  it("returns signed-out without a session", () => {
    assert.equal(deriveMembershipBranch(null, null), "signed-out");
  });

  it("returns no-org for a signed-in user with empty organizations", () => {
    assert.equal(
      deriveMembershipBranch(session, me({ user_id: "user-1", organizations: [] })),
      "no-org",
    );
  });

  it("returns no-org when identity is not registered yet", () => {
    assert.equal(
      deriveMembershipBranch(session, me({ user_id: null, organizations: [] })),
      "no-org",
    );
  });

  it("returns pending when only pending organizations exist", () => {
    assert.equal(
      deriveMembershipBranch(
        session,
        me({
          organizations: [{ tenant_id: "tenant-b", status: "pending" }],
        }),
      ),
      "pending",
    );
  });

  it("returns enabled when at least one enabled organization exists", () => {
    assert.equal(
      deriveMembershipBranch(
        session,
        me({
          organizations: [
            { tenant_id: "tenant-b", status: "pending" },
            { tenant_id: "anthus", status: "enabled" },
          ],
        }),
      ),
      "enabled",
    );
  });
});

describe("pickActiveOrg", () => {
  it("prefers the lexicographically first enabled organization", () => {
    assert.deepEqual(
      pickActiveOrg(
        me({
          organizations: [
            { tenant_id: "zeta", status: "enabled" },
            { tenant_id: "anthus", status: "enabled" },
          ],
        }),
      ),
      { tenantId: "anthus", userId: "user-1" },
    );
  });
});
