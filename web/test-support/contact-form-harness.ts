import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  setFetchForTests,
  submitContact,
  type ContactType,
  type SubmitContactPayload,
} from "../lib/contact-api";
import {
  setTrackConversionForTests,
  type ConversionEventName,
} from "../lib/conversion-tracking";

const statePath =
  process.env.CHATTICUS_CONTACT_FORM_HARNESS_STATE ??
  join(tmpdir(), "chatticus-contact-form-harness-state.json");

type HarnessState = {
  contactType: ContactType | null;
  conversionEvents: ConversionEventName[];
  lastSubmitPayload: SubmitContactPayload | null;
  submitResponseStatus: number;
};

function emptyState(): HarnessState {
  return {
    contactType: null,
    conversionEvents: [],
    lastSubmitPayload: null,
    submitResponseStatus: 201,
  };
}

function loadState(): HarnessState {
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as HarnessState;
  } catch {
    return emptyState();
  }
}

function saveState(state: HarnessState): HarnessState {
  writeFileSync(statePath, JSON.stringify(state));
  return state;
}

function clearStateFile(): void {
  try {
    unlinkSync(statePath);
  } catch {
    // no prior state
  }
}

function installHarness(state: HarnessState): void {
  setFetchForTests(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as SubmitContactPayload;
    state.lastSubmitPayload = body;
    if (state.submitResponseStatus !== 201) {
      return new Response("submission failed", { status: state.submitResponseStatus });
    }
    return new Response(JSON.stringify({ status: "recorded" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  });
  setTrackConversionForTests((eventName) => {
    state.conversionEvents.push(eventName);
    saveState(state);
  });
}

function resetHarness(contactType: ContactType): HarnessState {
  clearStateFile();
  const state = { ...emptyState(), contactType };
  installHarness(state);
  return saveState(state);
}

async function submitHarnessForm(
  contactType: ContactType,
  payload: SubmitContactPayload,
): Promise<HarnessState> {
  const state = loadState();
  state.contactType = contactType;
  installHarness(state);
  await submitContact(payload);
  const conversionEvent: ConversionEventName =
    contactType === "professional_services" ? "contact_services" : "contact_training";
  const { trackConversion } = await import("../lib/conversion-tracking");
  trackConversion(conversionEvent);
  return saveState(state);
}

async function main(): Promise<void> {
  const [command, payloadJson] = process.argv.slice(2);
  let result: HarnessState;

  switch (command) {
    case "reset-services":
      result = resetHarness("professional_services");
      break;
    case "reset-training":
      result = resetHarness("professional_training");
      break;
    case "submit-services": {
      const payload = JSON.parse(payloadJson ?? "{}") as SubmitContactPayload;
      result = await submitHarnessForm("professional_services", payload);
      break;
    }
    case "submit-training": {
      const payload = JSON.parse(payloadJson ?? "{}") as SubmitContactPayload;
      result = await submitHarnessForm("professional_training", payload);
      break;
    }
    default:
      throw new Error(`Unknown contact form harness command: ${command}`);
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

void main();
