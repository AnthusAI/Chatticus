import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatOrganizationMembershipList,
  membershipVisibleText,
  sortOrganizationMembershipRows,
} from "./organization-membership";
import type { MeOrganization } from "./me";

function organization(
  tenant_id: string,
  name: string,
  status: MeOrganization["status"] = "pending",
): MeOrganization {
  return { tenant_id, name, status };
}

describe("sortOrganizationMembershipRows", () => {
  it("sorts by tenant_id", () => {
    const sorted = sortOrganizationMembershipRows([
      organization("zeta", "Zeta Labs"),
      organization("alpha", "Alpha Labs"),
    ]);
    assert.equal(sorted[0]?.tenant_id, "alpha");
    assert.equal(sorted[1]?.tenant_id, "zeta");
  });
});

describe("formatOrganizationMembershipList", () => {
  it("renders name status and organization id", () => {
    const text = formatOrganizationMembershipList([
      organization("acme-labs", "Acme Labs", "pending"),
    ]);
    assert.match(text, /Acme Labs/);
    assert.match(text, /Status: pending/);
    assert.match(text, /Organization ID: acme-labs/);
  });
});

describe("membershipVisibleText", () => {
  it("keeps welcome copy separate from organization rows", () => {
    const text = membershipVisibleText("Welcome to Chatticus", [
      organization("acme-labs", "Acme Labs", "pending"),
    ]);
    assert.match(text, /^Welcome to Chatticus\n\nAcme Labs/);
  });
});
