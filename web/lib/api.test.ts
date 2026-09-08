import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { setIdTokenSourceForTests } from "./api-auth";
import { createBot, listBots } from "./api";

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

  it("send Authorization and Idempotency-Key on createBot", async () => {
    setIdTokenSourceForTests(async () => "org-scoped-token");
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = mock.fn(async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(
        JSON.stringify({
          bot_id: "bot-1",
          tenant_id: "anthus",
          user_id: "ryan",
          name: "Ping",
          memory: {},
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof fetch;

    const bot = await createBot({ tenantId: "anthus", userId: "ryan" }, "Ping");
    assert.equal(bot.name, "Ping");
    assert.equal(capturedUrl, "/api/orgs/anthus/bots");
    assert.equal(capturedInit?.method, "POST");
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer org-scoped-token");
    assert.equal(headers["Content-Type"], "application/json");
    assert.match(headers["Idempotency-Key"], /^[0-9a-f-]{36}$/i);
    assert.deepEqual(JSON.parse(String(capturedInit?.body)), { name: "Ping" });
  });
});
