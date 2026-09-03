import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fetchWaitlistSurvey,
  setFetchForTests,
  submitWaitlist,
  type SubmitWaitlistPayload,
} from "../lib/waitlist-api";
import { captureUtmFromUrl, installInMemoryAnalyticsForTests, readAnalyticsEventsForTests, trackSignupComplete } from "../lib/analytics";
import { FULL_WAITLIST_SURVEY_FIXTURE } from "../lib/waitlist-survey-fixture";

const statePath =
  process.env.CHATTICUS_SURVEY_FORM_HARNESS_STATE ??
  join(tmpdir(), "chatticus-survey-form-harness-state.json");

type RecordedRequest = {
  url: string;
  method: string;
  body: SubmitWaitlistPayload | null;
};

type HarnessState = {
  recordedRequests: RecordedRequest[];
  surveyResponseStatus: number;
  submitResponseStatus: number;
  lastSubmitPayload: SubmitWaitlistPayload | null;
  surveyFetched: boolean;
  analyticsEvents: ReturnType<typeof readAnalyticsEventsForTests>;
};

function emptyState(): HarnessState {
  return {
    recordedRequests: [],
    surveyResponseStatus: 200,
    submitResponseStatus: 201,
    lastSubmitPayload: null,
    surveyFetched: false,
    analyticsEvents: [],
  };
}

function loadState(): HarnessState {
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as HarnessState;
  } catch {
    return emptyState();
  }
}

function snapshotState(state: HarnessState): HarnessState {
  return {
    ...state,
    analyticsEvents: readAnalyticsEventsForTests(),
  };
}

function saveState(state: HarnessState): HarnessState {
  const snapshot = snapshotState(state);
  writeFileSync(statePath, JSON.stringify(snapshot));
  return snapshot;
}

function clearStateFile(): void {
  try {
    unlinkSync(statePath);
  } catch {
    // no prior state
  }
}

function installFetch(state: HarnessState): void {
  setFetchForTests(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    let body: SubmitWaitlistPayload | null = null;
    if (init?.body) {
      body = JSON.parse(String(init.body)) as SubmitWaitlistPayload;
    }
    state.recordedRequests.push({ url, method, body });
    if (url.endsWith("/waitlist/survey")) {
      state.surveyFetched = true;
      if (state.surveyResponseStatus !== 200) {
        return new Response("survey unavailable", { status: state.surveyResponseStatus });
      }
      return new Response(JSON.stringify(FULL_WAITLIST_SURVEY_FIXTURE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/waitlist") && method === "POST") {
      state.lastSubmitPayload = body;
      if (state.submitResponseStatus !== 201) {
        return new Response("rate limited", { status: state.submitResponseStatus });
      }
      return new Response(JSON.stringify({ status: "recorded" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  });
}

function resetHarness(): HarnessState {
  clearStateFile();
  installInMemoryAnalyticsForTests();
  const state = emptyState();
  installFetch(state);
  return saveState(state);
}

async function loadSurvey(): Promise<HarnessState> {
  const state = loadState();
  installFetch(state);
  await fetchWaitlistSurvey();
  return saveState(state);
}

async function submitIncomplete(email: string): Promise<HarnessState> {
  const state = loadState();
  installFetch(state);
  await submitWaitlist({
    email,
    fit_answers: {},
    aws_readiness_answers: {},
    price_answers: {},
    setup_path_answers: {},
    complete: false,
  });
  return saveState(state);
}

async function submitComplete(payload: SubmitWaitlistPayload): Promise<HarnessState> {
  const state = loadState();
  installInMemoryAnalyticsForTests();
  installFetch(state);
  try {
    await submitWaitlist(payload);
    if (payload.complete) {
      trackSignupComplete();
    }
  } catch {
    // Non-201 responses are recorded on the harness state.
  }
  return saveState(state);
}

async function captureUtmAndSubmitComplete(
  query: string,
  payload: SubmitWaitlistPayload,
): Promise<HarnessState> {
  const state = loadState();
  installInMemoryAnalyticsForTests();
  captureUtmFromUrl(new URLSearchParams(query.startsWith("?") ? query.slice(1) : query));
  installFetch(state);
  try {
    await submitWaitlist(payload);
    if (payload.complete) {
      trackSignupComplete();
    }
  } catch {
    // Non-201 responses are recorded on the harness state.
  }
  return saveState(state);
}

async function main(): Promise<void> {
  const [command, payloadJson] = process.argv.slice(2);
  let result: HarnessState;

  switch (command) {
    case "reset":
      result = resetHarness();
      break;
    case "load-survey":
      result = await loadSurvey();
      break;
    case "submit-incomplete": {
      const payload = JSON.parse(payloadJson ?? "{}") as { email?: string };
      result = await submitIncomplete(payload.email ?? "abandon@example.com");
      break;
    }
    case "submit-complete": {
      const payload = JSON.parse(payloadJson ?? "{}") as SubmitWaitlistPayload;
      result = await submitComplete(payload);
      break;
    }
    case "submit-complete-with-utm": {
      const payload = JSON.parse(payloadJson ?? "{}") as SubmitWaitlistPayload & {
        query?: string;
      };
      const { query, ...submitPayload } = payload;
      result = await captureUtmAndSubmitComplete(query ?? "", submitPayload);
      break;
    }
    case "set-submit-status": {
      const payload = JSON.parse(payloadJson ?? "{}") as { status?: number };
      const state = loadState();
      state.submitResponseStatus = payload.status ?? 429;
      installFetch(state);
      result = saveState(state);
      break;
    }
    default:
      throw new Error(`Unknown survey form harness command: ${command}`);
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

void main();
