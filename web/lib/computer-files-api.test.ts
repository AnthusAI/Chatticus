import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { setIdTokenSourceForTests } from "./api-auth";
import { FilesApiError } from "./computer-files";
import { listComputerFiles, readComputerFileRange } from "./computer-files-api";
import { textFileRange, workspaceListing } from "./computer-files-fixtures";

const originalFetch = globalThis.fetch;
const org = { tenantId: "acme", userId: "ryan" };

beforeEach(() => {
  setIdTokenSourceForTests(async () => "tok");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setIdTokenSourceForTests(null);
});

function stub(status: number, body: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = mock.fn(async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

describe("computer file routes", () => {
  it("GETs the listing with the session token and no body", async () => {
    setIdTokenSourceForTests(async () => "tok");
    const calls = stub(200, workspaceListing);
    const listing = await listComputerFiles(org, "/workspace/src");
    assert.equal(listing.entries.length, workspaceListing.entries.length);
    assert.equal(calls[0].url, "/api/orgs/acme/computer/files?path=%2Fworkspace%2Fsrc");
    assert.equal(calls[0].init?.method, undefined);
    assert.deepEqual(calls[0].init?.headers, { Authorization: "Bearer tok" });
  });

  it("GETs one content range by offset and length", async () => {
    const calls = stub(200, textFileRange);
    await readComputerFileRange(org, "/workspace/notes.txt", 262144);
    assert.equal(
      calls[0].url,
      "/api/orgs/acme/computer/files/content?path=%2Fworkspace%2Fnotes.txt&offset=262144&length=262144",
    );
  });

  it("raises a typed error carrying the server code", async () => {
    stub(404, { error: "no_snapshot", message: "never published" });
    await assert.rejects(listComputerFiles(org, "/workspace"), (error: unknown) => {
      assert.ok(error instanceof FilesApiError);
      assert.equal(error.status, 404);
      assert.equal(error.code, "no_snapshot");
      return true;
    });
  });

  it("raises a typed error with no code when the body is not JSON", async () => {
    globalThis.fetch = mock.fn(async () => new Response("<html>bad gateway</html>", { status: 502 })) as typeof fetch;
    await assert.rejects(listComputerFiles(org, "/workspace"), (error: unknown) => {
      assert.ok(error instanceof FilesApiError);
      assert.equal(error.code, null);
      return true;
    });
  });
});
