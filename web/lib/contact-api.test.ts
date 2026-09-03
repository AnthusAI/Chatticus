import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ContactApiError,
  setFetchForTests,
  submitContact,
  type SubmitContactPayload,
} from "./contact-api";

describe("contact-api", () => {
  it("submitContact posts payloads to POST /contact", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody: SubmitContactPayload | null = null;
    setFetchForTests(async (input, init) => {
      capturedUrl = String(input);
      capturedMethod = init?.method ?? "GET";
      capturedBody = JSON.parse(String(init?.body)) as SubmitContactPayload;
      return new Response(JSON.stringify({ status: "recorded" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    });

    const payload: SubmitContactPayload = {
      email: "jane@example.com",
      contact_type: "professional_services",
      name: "Jane Doe",
      organization: "Acme",
      details: { resources_to_integrate: "Salesforce" },
    };
    await submitContact(payload);

    assert.equal(capturedUrl, "/api/contact");
    assert.equal(capturedMethod, "POST");
    assert.deepEqual(capturedBody, payload);
    setFetchForTests(null);
  });

  it("submitContact throws ContactApiError on failure", async () => {
    setFetchForTests(async () => new Response("bad request", { status: 422 }));
    await assert.rejects(
      () =>
        submitContact({
          email: "jane@example.com",
          contact_type: "professional_training",
          details: { team_size: "12" },
        }),
      ContactApiError,
    );
    setFetchForTests(null);
  });
});
