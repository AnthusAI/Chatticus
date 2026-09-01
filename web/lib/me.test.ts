import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { setIdTokenSourceForTests } from "./api-auth";
import { fetchMe } from "./me";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  setIdTokenSourceForTests(null);
});

describe("fetchMe", () => {
  it("requests GET /api/me with Authorization when a session token exists", async () => {
    setIdTokenSourceForTests(async () => "test-id-token");
    let capturedUrl = "";
    let capturedHeaders: HeadersInit | undefined;
    globalThis.fetch = mock.fn(async (input, init) => {
      capturedUrl = String(input);
      capturedHeaders = init?.headers;
      return new Response(
        JSON.stringify({
          email: "owner@example.com",
          user_id: "user-1",
          organizations: [{ tenant_id: "anthus", status: "enabled" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const body = await fetchMe();
    assert.equal(capturedUrl, "/api/me");
    assert.deepEqual(capturedHeaders, { Authorization: "Bearer test-id-token" });
    assert.equal(body.email, "owner@example.com");
    assert.equal(body.organizations[0]?.tenant_id, "anthus");
  });
});
