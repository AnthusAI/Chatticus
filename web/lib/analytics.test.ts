import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  captureUtmFromUrl,
  getStoredUtmParams,
  installInMemoryAnalyticsForTests,
  readAnalyticsEventsForTests,
  resetAnalyticsForTests,
  setSessionStorageForTests,
  trackPageView,
  trackSignupComplete,
} from "./analytics";

afterEach(() => {
  setSessionStorageForTests(null);
  resetAnalyticsForTests();
});

describe("analytics", () => {
  it("captures UTM parameters from the query string into session storage", () => {
    installInMemoryAnalyticsForTests();
    captureUtmFromUrl(
      new URLSearchParams("utm_source=google&utm_campaign=beta_launch&utm_medium=cpc"),
    );

    assert.deepEqual(getStoredUtmParams(), {
      utm_source: "google",
      utm_campaign: "beta_launch",
      utm_medium: "cpc",
    });
  });

  it("fires page_view and signup_complete events", () => {
    installInMemoryAnalyticsForTests();
    captureUtmFromUrl(new URLSearchParams("utm_source=google"));
    trackPageView();
    trackSignupComplete();

    const events = readAnalyticsEventsForTests();
    assert.equal(events.length, 2);
    assert.equal(events[0]?.event, "page_view");
    assert.equal(events[1]?.event, "signup_complete");
    assert.equal(events[1]?.utm_source, "google");
  });
});
