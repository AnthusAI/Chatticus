export type UtmParams = {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
};

export type AnalyticsEvent = {
  event: string;
  timestamp: string;
} & Record<string, string | undefined>;

const UTM_STORAGE_KEY = "chatticus_utm_params";
const EVENT_QUEUE_KEY = "chatticus_analytics_events";

type SessionStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

let sessionStorageOverride: SessionStorageLike | null = null;

const UTM_QUERY_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
] as const;

function sessionStore(): SessionStorageLike | null {
  if (sessionStorageOverride) {
    return sessionStorageOverride;
  }
  if (typeof sessionStorage !== "undefined") {
    return sessionStorage;
  }
  return null;
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && sessionStore() !== null;
}

function readEventQueue(): AnalyticsEvent[] {
  const storage = sessionStore();
  if (!storage) {
    return [];
  }
  try {
    const raw = storage.getItem(EVENT_QUEUE_KEY);
    if (!raw) {
      return [];
    }
    return JSON.parse(raw) as AnalyticsEvent[];
  } catch {
    return [];
  }
}

function writeEventQueue(events: AnalyticsEvent[]): void {
  const storage = sessionStore();
  if (!storage) {
    return;
  }
  storage.setItem(EVENT_QUEUE_KEY, JSON.stringify(events));
}

function logAnalytics(message: string, detail: unknown): void {
  if (typeof window !== "undefined") {
    console.info(message, detail);
  }
}

function enqueueEvent(event: AnalyticsEvent): void {
  const events = readEventQueue();
  events.push(event);
  writeEventQueue(events);
  logAnalytics("[chatticus-analytics]", event);
}

function flushEventQueue(): void {
  const events = readEventQueue();
  if (events.length === 0) {
    return;
  }
  logAnalytics("[chatticus-analytics] flush", events);
  writeEventQueue([]);
}

let flushListenersInstalled = false;

function installFlushListeners(): void {
  if (!isBrowser() || flushListenersInstalled) {
    return;
  }
  flushListenersInstalled = true;
  window.addEventListener("pagehide", flushEventQueue);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushEventQueue();
    }
  });
}

export function captureUtmFromUrl(searchParams: URLSearchParams): UtmParams {
  const captured: UtmParams = {};
  for (const key of UTM_QUERY_KEYS) {
    const value = searchParams.get(key)?.trim();
    if (value) {
      captured[key] = value;
    }
  }

  const storage = sessionStore();
  if (!storage) {
    return captured;
  }

  const existing = getStoredUtmParams();
  const merged = { ...existing, ...captured };
  if (Object.keys(merged).length > 0) {
    storage.setItem(UTM_STORAGE_KEY, JSON.stringify(merged));
  }
  return merged;
}

export function getStoredUtmParams(): UtmParams {
  const storage = sessionStore();
  if (!storage) {
    return {};
  }
  try {
    const raw = storage.getItem(UTM_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    return JSON.parse(raw) as UtmParams;
  } catch {
    return {};
  }
}

export function trackPageView(path?: string): void {
  installFlushListeners();
  enqueueEvent({
    event: "page_view",
    timestamp: new Date().toISOString(),
    path: path ?? (typeof window !== "undefined" ? window.location.pathname : undefined),
  });
}

export function trackSignupComplete(): void {
  installFlushListeners();
  const utm = getStoredUtmParams();
  enqueueEvent({
    event: "signup_complete",
    timestamp: new Date().toISOString(),
    ...utm,
  });
}

export function initializePageAnalytics(searchParams?: URLSearchParams): void {
  const params =
    searchParams ??
    (typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams());
  captureUtmFromUrl(params);
  trackPageView();
}

/** Test-only hook to stub session storage for harnesses and unit tests. */
export function setSessionStorageForTests(source: SessionStorageLike | null): void {
  sessionStorageOverride = source;
  flushListenersInstalled = false;
}

function createInMemorySessionStorage(): SessionStorageLike {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.has(key) ? values.get(key)! : null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
}

/** Test-only helpers for harnesses and unit tests. */
export function resetAnalyticsForTests(): void {
  const storage = sessionStore();
  if (storage) {
    storage.removeItem(UTM_STORAGE_KEY);
    storage.removeItem(EVENT_QUEUE_KEY);
  }
  flushListenersInstalled = false;
}

export function readAnalyticsEventsForTests(): AnalyticsEvent[] {
  return readEventQueue();
}

export function installInMemoryAnalyticsForTests(): SessionStorageLike {
  const storage = createInMemorySessionStorage();
  setSessionStorageForTests(storage);
  return storage;
}
