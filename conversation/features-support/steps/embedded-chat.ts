import { Given, When, Then } from "@cucumber/cucumber";
import { require as tsxRequire } from "tsx/cjs/api";
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

Given("an application renders the shared chat with its own conversation", function () {});
When("its editor sends a message from the composer", { timeout: 120_000 }, async function () {
  const result = await promisify(execFile)(process.execPath, ["../web/scripts/test-embedded-chat.mjs"], { maxBuffer: 4 * 1024 * 1024 });
  this.embeddedChatResult = result.stdout;
});
Then("the host receives one message and renders its response", function () {
  assert.ok(this.embeddedChatResult.includes("Standalone chat send passed"));
});
Then("no Chatticus account, roster or computer is required", function () {
  assert.ok(this.embeddedChatResult.includes("No product dependencies"));
});

Given("an application observes stored events for one turn", async function () {
  const { createResumableTurnStream } = tsxRequire("../../../chat/client/index.ts", import.meta.url);
  this.createEmbeddedStream = createResumableTurnStream;
  this.embeddedEvents = [];
  this.embeddedCursors = [];
});
When("the connection ends after its first event", async function () {
  await new Promise<void>((resolve) => {
    let attempt = 0;
    const stream = this.createEmbeddedStream({
      retryDelayMillisecondsForRetry: () => 0,
      onAttemptStart: () => {},
      onEvent: (event: { seq: number }) => this.embeddedEvents.push(event.seq),
      onGaveUp: (message: string) => { throw new Error(message); },
      openStream: (handlers: { onEvent: (event: unknown) => void; onClose: () => void }, cursor: number) => {
        this.embeddedCursors.push(cursor);
        const current = attempt++;
        queueMicrotask(() => {
          handlers.onEvent({ kind: "turn.token", turn_id: "one", seq: 1, token: "Hello" });
          if (current === 0) handlers.onClose();
          else {
            handlers.onEvent({ kind: "turn.completed", turn_id: "one", seq: 2 });
            stream.close();
            resolve();
          }
        });
        return () => {};
      },
    });
    stream.start();
  });
});
Then("the shared client resumes after that event", function () {
  assert.deepEqual(this.embeddedCursors, [0, 1]);
});
Then("replayed events are delivered once", function () {
  assert.deepEqual(this.embeddedEvents, [1, 2]);
});

Given("the host cannot provide current authentication headers", async function () {
  const { openTurnEventStream } = tsxRequire("../../../chat/client/index.ts", import.meta.url);
  this.openEmbeddedStream = openTurnEventStream;
  this.embeddedFetchCalls = 0;
});
When("the shared client opens a turn observer", async function () {
  await new Promise<void>((resolve) => {
    this.openEmbeddedStream({
      url: "https://chat.invalid/turn/stream",
      headers: async () => { throw new Error("Editor session expired"); },
      fetch: async () => { this.embeddedFetchCalls += 1; return new Response(); },
    }, { onEvent: () => {}, onError: (error: Error) => { this.embeddedAuthError = error.message; resolve(); } });
  });
});
Then("the host receives its authentication error", function () {
  assert.equal(this.embeddedAuthError, "Editor session expired");
});
Then("no stream request is sent", function () {
  assert.equal(this.embeddedFetchCalls, 0);
});
