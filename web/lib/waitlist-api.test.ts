import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import {
  confirmWaitlistEmail,
  consumeWaitlistInvitation,
  fetchWaitlistSurvey,
  setFetchForTests,
  submitWaitlist,
} from "./waitlist-api";
import { FULL_WAITLIST_SURVEY_FIXTURE } from "./waitlist-survey-fixture";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  setFetchForTests(null);
});

describe("waitlist API", () => {
  it("fetchWaitlistSurvey requests GET /waitlist/survey", async () => {
    let capturedUrl = "";
    setFetchForTests(
      mock.fn(async (input) => {
        capturedUrl = String(input);
        return new Response(JSON.stringify(FULL_WAITLIST_SURVEY_FIXTURE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    );

    const survey = await fetchWaitlistSurvey();
    assert.equal(capturedUrl, "/api/waitlist/survey");
    assert.ok(survey.price_sensitivity);
  });

  it("submitWaitlist posts complete payloads to POST /waitlist", async () => {
    let capturedInit: RequestInit | undefined;
    setFetchForTests(
      mock.fn(async (_input, init) => {
        capturedInit = init;
        return new Response(JSON.stringify({ status: "recorded" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    );

    await submitWaitlist({
      email: "person@example.com",
      fit_answers: {},
      aws_readiness_answers: {},
      price_answers: {},
      setup_path_answers: {},
      complete: true,
    });

    assert.equal(capturedInit?.method, "POST");
    const body = JSON.parse(String(capturedInit?.body)) as { complete: boolean };
    assert.equal(body.complete, true);
  });

  it("confirmWaitlistEmail requests GET /waitlist/confirm with query params", async () => {
    let capturedUrl = "";
    setFetchForTests(
      mock.fn(async (input) => {
        capturedUrl = String(input);
        return new Response(
          JSON.stringify({
            status: "confirmed",
            message: "Your email is confirmed. You are on the waitlist.",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }) as typeof fetch,
    );

    const result = await confirmWaitlistEmail("person@example.com", "token-123");
    assert.equal(
      capturedUrl,
      "/api/waitlist/confirm?email=person%40example.com&token=token-123",
    );
    assert.equal(result.status, "confirmed");
  });

  it("consumeWaitlistInvitation requests GET /waitlist/invite with token", async () => {
    let capturedUrl = "";
    setFetchForTests(
      mock.fn(async (input) => {
        capturedUrl = String(input);
        return new Response(
          JSON.stringify({
            status: "accepted",
            message: "Your invitation is accepted. Sign in to continue.",
            sign_in_url: "/chat",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }) as typeof fetch,
    );

    const result = await consumeWaitlistInvitation("invite-token-123");
    assert.equal(capturedUrl, "/api/waitlist/invite?token=invite-token-123");
    assert.equal(result.status, "accepted");
    assert.equal(result.sign_in_url, "/chat");
  });
});
