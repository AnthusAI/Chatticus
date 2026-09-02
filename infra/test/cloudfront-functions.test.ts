import assert from "node:assert/strict";
import vm from "node:vm";
import { describe, it } from "node:test";

import {
  buildSpaViewerRequestFunction,
  SPA_VIEWER_REQUEST_FUNCTION,
  SPA_VIEWER_RESPONSE_FUNCTION,
} from "../lib/cloudfront-functions";

type ViewerRequestEvent = {
  request: {
    uri: string;
    headers: Record<string, { value: string }>;
  };
};

function runViewerRequest(
  functionSource: string,
  event: ViewerRequestEvent,
): ViewerRequestEvent["request"] {
  const context = { event };
  return vm.runInNewContext(`${functionSource}\nhandler(event);`, context) as ViewerRequestEvent["request"];
}

function viewerRequestEvent(
  uri: string,
  host?: string,
): ViewerRequestEvent {
  return {
    request: {
      uri,
      headers: host ? { host: { value: host } } : {},
    },
  };
}

const productionSpaViewerRequest = buildSpaViewerRequestFunction({
  appDomain: "hey.chattic.us",
  marketingDomain: "chattic.us",
});

describe("SPA viewer-request rewrite", () => {
  it("rewrites slashless /auth/callback to the Next export index", () => {
    assert.match(SPA_VIEWER_REQUEST_FUNCTION, /uri === "\/auth\/callback"/);
    assert.match(
      SPA_VIEWER_REQUEST_FUNCTION,
      /request\.uri = "\/auth\/callback\/index\.html"/,
    );
  });

  it("rewrites slashless /auth/signout-callback to the Next export index", () => {
    assert.match(SPA_VIEWER_REQUEST_FUNCTION, /uri === "\/auth\/signout-callback"/);
    assert.match(
      SPA_VIEWER_REQUEST_FUNCTION,
      /request\.uri = "\/auth\/signout-callback\/index\.html"/,
    );
  });

  it("does not rewrite /api paths", () => {
    assert.match(SPA_VIEWER_REQUEST_FUNCTION, /uri\.indexOf\("\/api"\) === 0/);
  });

  it("rewrites /chat to /chat/index.html on every host", () => {
    for (const host of [
      "dev.chattic.us",
      "staging.chattic.us",
      "chattic.us",
      "hey.chattic.us",
    ]) {
      const request = runViewerRequest(
        SPA_VIEWER_REQUEST_FUNCTION,
        viewerRequestEvent("/chat", host),
      );
      assert.equal(request.uri, "/chat/index.html", host);
    }
  });

  it("leaves marketing / unchanged on dev, staging, and apex", () => {
    for (const host of ["dev.chattic.us", "staging.chattic.us", "chattic.us"]) {
      const request = runViewerRequest(
        productionSpaViewerRequest,
        viewerRequestEvent("/", host),
      );
      assert.equal(request.uri, "/", host);
    }
  });
});

describe("production Host-based viewer-request routing", () => {
  it("rewrites hey.chattic.us / to /chat/index.html", () => {
    const request = runViewerRequest(
      productionSpaViewerRequest,
      viewerRequestEvent("/", "hey.chattic.us"),
    );
    assert.equal(request.uri, "/chat/index.html");
  });

  it("rewrites hey.chattic.us /chat to /chat/index.html", () => {
    const request = runViewerRequest(
      productionSpaViewerRequest,
      viewerRequestEvent("/chat", "hey.chattic.us"),
    );
    assert.equal(request.uri, "/chat/index.html");
  });

  it("leaves chattic.us / unchanged", () => {
    const request = runViewerRequest(
      productionSpaViewerRequest,
      viewerRequestEvent("/", "chattic.us"),
    );
    assert.equal(request.uri, "/");
  });

  it("keeps /auth/callback at the root on hey.chattic.us", () => {
    const request = runViewerRequest(
      productionSpaViewerRequest,
      viewerRequestEvent("/auth/callback", "hey.chattic.us"),
    );
    assert.equal(request.uri, "/auth/callback/index.html");
  });

  it("keeps /auth/signout-callback at the root on hey.chattic.us", () => {
    const request = runViewerRequest(
      productionSpaViewerRequest,
      viewerRequestEvent("/auth/signout-callback", "hey.chattic.us"),
    );
    assert.equal(request.uri, "/auth/signout-callback/index.html");
  });

  it("runs Host routing before slashless SPA rewrites", () => {
    const request = runViewerRequest(
      productionSpaViewerRequest,
      viewerRequestEvent("/auth/callback", "hey.chattic.us"),
    );
    assert.equal(request.uri, "/auth/callback/index.html");
    assert.doesNotMatch(request.uri, /^\/chat\//);
  });
});

describe("SPA viewer-response fallback", () => {
  it("still rewrites 403/404 to 200 for static assets", () => {
    assert.match(SPA_VIEWER_RESPONSE_FUNCTION, /response\.statusCode === 403/);
    assert.match(SPA_VIEWER_RESPONSE_FUNCTION, /response\.statusCode === 404/);
  });
});
