import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { VerifiedSession } from "./auth";
import type { MeResponse } from "./me";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { deriveMembershipBranch, pickActiveOrg, reuseActiveOrg } from "./membership-state";

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
          organizations: [{ tenant_id: "tenant-b", name: "Beta Labs", status: "pending", role: "owner" }],
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
            { tenant_id: "tenant-b", name: "Beta Labs", status: "pending", role: "owner" },
            { tenant_id: "anthus", name: "Anthus", status: "enabled", role: "owner" },
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
            { tenant_id: "zeta", name: "Zeta Labs", status: "enabled", role: "owner" },
            { tenant_id: "anthus", name: "Anthus", status: "enabled", role: "owner" },
          ],
        }),
      ),
      { tenantId: "anthus", userId: "user-1" },
    );
  });
});

describe("reuseActiveOrg", () => {
  const first = { tenantId: "acme", userId: "user-1" };

  it("keeps the same object when a reloaded /me names the same organization and user", () => {
    const reloaded = { tenantId: "acme", userId: "user-1" };
    assert.notEqual(reloaded, first);
    assert.equal(reuseActiveOrg(first, reloaded), first);
  });

  it("returns the new organization when the tenant or the user changes", () => {
    const otherTenant = { tenantId: "beta", userId: "user-1" };
    const otherUser = { tenantId: "acme", userId: "user-2" };
    assert.equal(reuseActiveOrg(first, otherTenant), otherTenant);
    assert.equal(reuseActiveOrg(first, otherUser), otherUser);
  });

  it("passes through a first organization and a lost one", () => {
    assert.equal(reuseActiveOrg(null, first), first);
    assert.equal(reuseActiveOrg(first, null), null);
    assert.equal(reuseActiveOrg(null, null), null);
  });
});

describe("membership context wiring", () => {
  it("derives activeOrg through reuseActiveOrg so a reloaded /me does not reload the workspace", () => {
    const source = readFileSync(join(__dirname, "membership-context.tsx"), "utf8");
    assert.match(source, /reuseActiveOrg\(/);
    assert.doesNotMatch(source, /const activeOrg = me \? pickActiveOrg\(me\) : null;/);
  });
});
