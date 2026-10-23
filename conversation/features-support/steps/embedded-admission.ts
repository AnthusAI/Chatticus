import { Given, When, Then } from "@cucumber/cucumber";
import { strict as assert } from "node:assert";

Given("a host prepares one message with a stable admission key", async function () {
  const shared = await import("../../../chat/client/index.ts");
  this.postSharedMessage = shared.postChatMessage;
  this.admissionRequests = [];
  this.admissionAuthCalls = 0;
  this.admissionMode = "normal";
  this.admissionBody = { author_kind: "human", author_id: "editor-one", body: "Check this draft", addressed_to_bot_id: "assistant-one" };
  this.admissionResponse = { message: { message_id: "canonical-message" }, turn_id: "canonical-turn" };
  this.admissionTransport = {
    url: "https://chat.invalid/channels/one/messages",
    headers: async () => {
      this.admissionAuthCalls += 1;
      if (this.admissionMode === "expired") throw new Error("Editor session expired");
      return { Authorization: `Bearer host-session-${this.admissionAuthCalls}` };
    },
    fetch: async (url: string, init: RequestInit) => {
      this.admissionRequests.push({ url, method: init.method, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
      if (this.admissionMode === "lost" && this.admissionRequests.length === 1) throw new Error("Response lost");
      if (this.admissionMode === "refused") return new Response("Editor is not authorized", { status: 403 });
      return Response.json(this.admissionResponse);
    },
  };
});
When("its first response is lost and the host retries that submission", async function () {
  this.admissionMode = "lost";
  await assert.rejects(() => this.postSharedMessage(this.admissionTransport, this.admissionBody, "stable-submission"), /Response lost/);
  assert.equal(this.admissionRequests.length, 1, "The client must not retry on its own");
  this.admittedMessage = await this.postSharedMessage(this.admissionTransport, this.admissionBody, "stable-submission");
});
Then("both requests carry the same key and freshly supplied authorization", function () {
  assert.equal(this.admissionRequests.length, 2);
  assert.equal(this.admissionAuthCalls, 2);
  for (const [index, request] of this.admissionRequests.entries()) {
    assert.equal(request.url, this.admissionTransport.url);
    assert.equal(request.method, "POST");
    assert.equal(request.headers.get("Idempotency-Key"), "stable-submission");
    assert.equal(request.headers.get("Authorization"), `Bearer host-session-${index + 1}`);
    assert.equal(request.headers.get("Content-Type"), "application/json");
    assert.deepEqual(request.body, this.admissionBody);
  }
});
Then("the host receives the original message and turn identity", function () {
  assert.deepEqual(this.admittedMessage, this.admissionResponse);
});
Given("the host session has expired before submission", function () { this.admissionMode = "expired"; });
Given("the server refuses message admission", function () { this.admissionMode = "refused"; });
When("the host submits its message", async function () {
  try { await this.postSharedMessage(this.admissionTransport, this.admissionBody, "stable-submission"); }
  catch (error) { this.admissionError = error; }
});
Then("the authorization failure reaches the host without a request", function () {
  assert.equal(this.admissionError?.message, "Editor session expired");
  assert.equal(this.admissionRequests.length, 0);
});
Then("the server refusal reaches the host after one request", function () {
  assert.equal(this.admissionError?.message, "HTTP 403: Editor is not authorized");
  assert.equal(this.admissionRequests.length, 1);
});

When("the host submits without an admission key", async function () {
  try { await this.postSharedMessage(this.admissionTransport, this.admissionBody, "  "); }
  catch (error) { this.admissionError = error; }
});
Then("the missing key is reported without a request", function () {
  assert.equal(this.admissionError?.message, "A stable message admission key is required");
  assert.equal(this.admissionRequests.length, 0);
  assert.equal(this.admissionAuthCalls, 0);
});
