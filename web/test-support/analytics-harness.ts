import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  captureUtmFromUrl,
  getStoredUtmParams,
  initializePageAnalytics,
  installInMemoryAnalyticsForTests,
  readAnalyticsEventsForTests,
  resetAnalyticsForTests,
  setSessionStorageForTests,
  trackSignupComplete,
  type AnalyticsEvent,
  type UtmParams,
} from "../lib/analytics";

const statePath =
  process.env.CHATTICUS_ANALYTICS_HARNESS_STATE ??
  join(tmpdir(), "chatticus-analytics-harness-state.json");

type HarnessState = {
  utmParams: UtmParams;
  events: AnalyticsEvent[];
};

function emptyState(): HarnessState {
  return {
    utmParams: {},
    events: [],
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

function snapshotState(): HarnessState {
  return {
    utmParams: getStoredUtmParams(),
    events: readAnalyticsEventsForTests(),
  };
}

function resetHarness(): HarnessState {
  clearStateFile();
  setSessionStorageForTests(null);
  resetAnalyticsForTests();
  installInMemoryAnalyticsForTests();
  return saveState(emptyState());
}

function captureUtm(queryString: string): HarnessState {
  installInMemoryAnalyticsForTests();
  resetAnalyticsForTests();
  const searchParams = new URLSearchParams(
    queryString.startsWith("?") ? queryString.slice(1) : queryString,
  );
  captureUtmFromUrl(searchParams);
  return saveState(snapshotState());
}

function loadBetaPage(): HarnessState {
  installInMemoryAnalyticsForTests();
  resetAnalyticsForTests();
  const query = process.env.CHATTICUS_ANALYTICS_HARNESS_QUERY ?? "";
  const searchParams = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
  initializePageAnalytics(searchParams);
  return saveState(snapshotState());
}

function fireSignupComplete(): HarnessState {
  installInMemoryAnalyticsForTests();
  trackSignupComplete();
  return saveState(snapshotState());
}

async function main(): Promise<void> {
  const [command, payloadJson] = process.argv.slice(2);
  let result: HarnessState;

  switch (command) {
    case "reset":
      result = resetHarness();
      break;
    case "capture-utm": {
      const payload = JSON.parse(payloadJson ?? "{}") as { query?: string };
      result = captureUtm(payload.query ?? "");
      break;
    }
    case "load-beta-page":
      if (payloadJson) {
        const payload = JSON.parse(payloadJson) as { query?: string };
        process.env.CHATTICUS_ANALYTICS_HARNESS_QUERY = payload.query ?? "";
      }
      result = loadBetaPage();
      break;
    case "track-signup-complete":
      result = fireSignupComplete();
      break;
    default:
      throw new Error(`Unknown analytics harness command: ${command}`);
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

void main();
