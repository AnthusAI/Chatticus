import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { setIdTokenSourceForTests } from "./api-auth";
import { listBots } from "./api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  setIdTokenSourceForTests(null);
});

describe("org-scoped API calls", () => {
  it("send Authorization on listBots when a session token exists", async () => {
    setIdTokenSourceForTests(async () => "org-scoped-token");
    let capturedHeaders: HeadersInit | undefined;
    globalThis.fetch = mock.fn(async (_input, init) => {
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({ bots: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await listBots({ tenantId: "anthus", userId: "ryan" });
    assert.deepEqual(capturedHeaders, { Authorization: "Bearer org-scoped-token" });
  });
});
