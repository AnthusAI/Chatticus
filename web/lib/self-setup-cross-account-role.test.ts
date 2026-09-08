import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CUSTOMER_ROLE_TEMPLATE_PATH } from "./self-setup-cross-account-role";

describe("self-setup cross-account role", () => {
  it("publishes the customer template at a stable same-origin path", () => {
    assert.equal(CUSTOMER_ROLE_TEMPLATE_PATH, "/provisioning/customer-role.yml");
  });
});
