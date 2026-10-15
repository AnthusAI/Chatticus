import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { setIdTokenSourceForTests } from "./api-auth";
import { FilesApiError } from "./computer-files";
import {
  createComputerDirectory,
  deleteComputerEntry,
  discardPendingChange,
  listComputerFiles,
  listPendingChanges,
  moveComputerEntry,
  quotedEtag,
  readComputerFileRange,
  revealComputerFile,
  sha256FromEtag,
  statComputerFile,
  watchComputerFiles,
  writeComputerFile,
} from "./computer-files-api";
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

describe("computer file change routes", () => {
  const sha = "a".repeat(64);

  it("PUTs the whole text with the loaded hash as a quoted If-Match", async () => {
    const calls = stub(200, { source: "live", sha256: sha });
    await writeComputerFile(org, "/workspace/notes.md", "second draft", { type: "if_match", sha256: sha });
    assert.equal(calls[0].url, "/api/orgs/acme/computer/files/content?path=%2Fworkspace%2Fnotes.md");
    assert.equal(calls[0].init?.method, "PUT");
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers["If-Match"], `"${sha}"`);
    assert.equal(headers["If-None-Match"], undefined);
    assert.equal(headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(calls[0].init?.body as string), { content: "second draft" });
  });

  it("creates a file with If-None-Match: * and no If-Match", async () => {
    const calls = stub(200, {});
    await writeComputerFile(org, "/workspace/new.md", "", { type: "if_none_match" });
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers["If-None-Match"], "*");
    assert.equal(headers["If-Match"], undefined);
  });

  it("carries current_sha256 and retry_after_ms on a refusal", async () => {
    stub(409, { error: "precondition_failed", message: "x", current_sha256: sha });
    await assert.rejects(
      writeComputerFile(org, "/workspace/a", "t", { type: "if_match", sha256: "b".repeat(64) }),
      (error: unknown) => {
        assert.ok(error instanceof FilesApiError);
        assert.equal(error.currentSha256, sha);
        return true;
      },
    );
    stub(503, { error: "computer_starting", message: "x", retry_after_ms: 2000 });
    await assert.rejects(writeComputerFile(org, "/workspace/a", "t", { type: "if_none_match" }), (error: unknown) => {
      assert.ok(error instanceof FilesApiError);
      assert.equal(error.retryAfterMs, 2000);
      return true;
    });
  });

  it("reads a Retry-After header in seconds when the body has no retry time", async () => {
    globalThis.fetch = mock.fn(
      async () => new Response(JSON.stringify({ error: "rate_limited", message: "x" }), { status: 429, headers: { "Retry-After": "7" } }),
    ) as typeof fetch;
    await assert.rejects(listComputerFiles(org, "/workspace"), (error: unknown) => {
      assert.ok(error instanceof FilesApiError);
      assert.equal(error.retryAfterMs, 7000);
      return true;
    });
  });

  it("reads the person's version of a conflicting change with variant=mine", async () => {
    const calls = stub(200, textFileRange);
    await readComputerFileRange(org, "/workspace/plan.md", 0, 262144, "mine");
    assert.match(calls[0].url, /variant=mine/);
  });

  it("DELETEs with If-Match, and recursive only when asked", async () => {
    const calls = stub(200, {});
    await deleteComputerEntry(org, "/workspace/old", sha, false);
    await deleteComputerEntry(org, "/workspace/old", sha, true);
    assert.equal(calls[0].init?.method, "DELETE");
    assert.equal(calls[0].url, "/api/orgs/acme/computer/files?path=%2Fworkspace%2Fold");
    assert.equal(calls[1].url, "/api/orgs/acme/computer/files?path=%2Fworkspace%2Fold&recursive=true");
    assert.equal((calls[1].init?.headers as Record<string, string>)["If-Match"], `"${sha}"`);
  });

  it("POSTs a rename with If-Match and a folder creation with neither precondition", async () => {
    const calls = stub(200, {});
    await moveComputerEntry(org, "/workspace/old.md", "/workspace/new.md", sha);
    await createComputerDirectory(org, "/workspace/docs");
    assert.equal(calls[0].url, "/api/orgs/acme/computer/files/move");
    assert.deepEqual(JSON.parse(calls[0].init?.body as string), { from: "/workspace/old.md", to: "/workspace/new.md" });
    assert.equal((calls[0].init?.headers as Record<string, string>)["If-Match"], `"${sha}"`);
    assert.equal(calls[1].url, "/api/orgs/acme/computer/files/directories");
    const folderHeaders = calls[1].init?.headers as Record<string, string>;
    assert.equal(folderHeaders["If-Match"], undefined);
    assert.equal(folderHeaders["If-None-Match"], undefined);
  });

  it("reads the hash a delete needs from the ETag of a stat", async () => {
    globalThis.fetch = mock.fn(
      async () => new Response(JSON.stringify({ entry: {} }), { status: 200, headers: { ETag: quotedEtag(sha) } }),
    ) as typeof fetch;
    const { etagSha256 } = await statComputerFile(org, "/workspace/old");
    assert.equal(etagSha256, sha);
    assert.equal(sha256FromEtag(`W/"${sha}"`), null);
    assert.equal(sha256FromEtag(null), null);
  });

  it("pings watch with open true or false, keepalive only on the closing ping", async () => {
    const calls = stub(200, { state: "live", interactive_until: null, poll_interval_ms: null });
    await watchComputerFiles(org, true);
    await watchComputerFiles(org, false, true);
    assert.deepEqual(JSON.parse(calls[0].init?.body as string), { open: true });
    assert.equal(calls[0].init?.keepalive, false);
    assert.deepEqual(JSON.parse(calls[1].init?.body as string), { open: false });
    assert.equal(calls[1].init?.keepalive, true);
  });

  it("reveals by POSTing the path, and lists and discards pending changes", async () => {
    const calls = stub(200, { entries: [], discarded: true });
    await revealComputerFile(org, "/workspace/.env");
    await listPendingChanges(org);
    await discardPendingChange(org, "/workspace/a.txt", 3);
    assert.equal(calls[0].url, "/api/orgs/acme/computer/files/reveal");
    assert.deepEqual(JSON.parse(calls[0].init?.body as string), { path: "/workspace/.env" });
    assert.equal(calls[1].url, "/api/orgs/acme/computer/files/overlay");
    assert.equal(calls[2].url, "/api/orgs/acme/computer/files/overlay/discard");
    assert.deepEqual(JSON.parse(calls[2].init?.body as string), { path: "/workspace/a.txt", revision: 3 });
  });
});
