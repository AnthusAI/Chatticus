import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { authorizedHeaders, setIdTokenSourceForTests } from "./api-auth";

afterEach(() => {
  setIdTokenSourceForTests(null);
});

describe("authorizedHeaders", () => {
  it("adds Bearer when a session token exists", async () => {
    setIdTokenSourceForTests(async () => "session-id-token");
    const headers = await authorizedHeaders({ "Content-Type": "application/json" });
    assert.equal(headers.Authorization, "Bearer session-id-token");
    assert.equal(headers["Content-Type"], "application/json");
  });

  it("omits Authorization when no session token exists", async () => {
    setIdTokenSourceForTests(async () => null);
    const headers = await authorizedHeaders();
    assert.equal(headers.Authorization, undefined);
  });
});
