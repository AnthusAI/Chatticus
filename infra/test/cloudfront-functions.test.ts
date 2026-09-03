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

type ViewerResponseEvent = {
  request: { uri: string };
  response: {
    statusCode: number;
    statusDescription?: string;
    headers: Record<string, { value: string }>;
  };
};

function runViewerResponse(
  functionSource: string,
  event: ViewerResponseEvent,
): ViewerResponseEvent["response"] {
  const context = { event };
  return vm.runInNewContext(`${functionSource}\nhandler(event);`, context) as ViewerResponseEvent["response"];
}

function viewerResponseEvent(
  uri: string,
  statusCode = 200,
): ViewerResponseEvent {
  return {
    request: { uri },
    response: { statusCode, headers: {} },
  };
}

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
    const request = runViewerRequest(SPA_VIEWER_REQUEST_FUNCTION, viewerRequestEvent("/auth/callback"));
    assert.equal(request.uri, "/auth/callback/index.html");
  });

  it("rewrites slashless /auth/signout-callback to the Next export index", () => {
    const request = runViewerRequest(
      SPA_VIEWER_REQUEST_FUNCTION,
      viewerRequestEvent("/auth/signout-callback"),
    );
    assert.equal(request.uri, "/auth/signout-callback/index.html");
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

  it("rewrites any nested extensionless route to its Next export index, not just a hardcoded list", () => {
    // Regression: this used to be a hardcoded per-route list (/chat,
    // /auth/callback, /auth/signout-callback) that silently 403ed every
    // other route -- e.g. /features/flex-mode, added after that list was
    // written and never added to it.
    for (const uri of ["/features/flex-mode", "/features/model-flexibility", "/some/deeply/nested/route"]) {
      const request = runViewerRequest(SPA_VIEWER_REQUEST_FUNCTION, viewerRequestEvent(uri));
      assert.equal(request.uri, `${uri}/index.html`, uri);
    }
  });

  it("leaves a trailing-slash route's URI as <path>index.html, not <path>/index.html", () => {
    const request = runViewerRequest(SPA_VIEWER_REQUEST_FUNCTION, viewerRequestEvent("/features/flex-mode/"));
    assert.equal(request.uri, "/features/flex-mode/index.html");
  });

  it("does not rewrite extensionless metadata image routes at any nesting depth", () => {
    for (const uri of ["/opengraph-image", "/chat/opengraph-image", "/features/flex-mode/opengraph-image"]) {
      const request = runViewerRequest(SPA_VIEWER_REQUEST_FUNCTION, viewerRequestEvent(uri));
      assert.equal(request.uri, uri, uri);
    }
  });

  it("does not rewrite static assets that already have a file extension", () => {
    for (const uri of ["/favicon.svg", "/_next/static/chunks/123.js"]) {
      const request = runViewerRequest(SPA_VIEWER_REQUEST_FUNCTION, viewerRequestEvent(uri));
      assert.equal(request.uri, uri, uri);
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

  it("forces the correct content-type for every route's social preview image", () => {
    for (const uri of ["/opengraph-image", "/chat/opengraph-image", "/features/flex-mode/opengraph-image"]) {
      const response = runViewerResponse(SPA_VIEWER_RESPONSE_FUNCTION, viewerResponseEvent(uri));
      assert.equal(response.headers["content-type"].value, "image/png", uri);
    }
  });

  it("leaves other static assets' content-type untouched", () => {
    const response = runViewerResponse(
      SPA_VIEWER_RESPONSE_FUNCTION,
      viewerResponseEvent("/favicon.svg"),
    );
    assert.equal(response.headers["content-type"], undefined);
  });
});
