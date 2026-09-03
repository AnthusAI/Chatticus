/** Strip /api prefix and Accept-Encoding before the Lambda function URL origin. */
export const API_ORIGIN_VIEWER_REQUEST_FUNCTION = `function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.indexOf("/api/") === 0) {
    request.uri = uri.substring(4);
  } else if (uri === "/api") {
    request.uri = "/";
  }
  if (request.headers["accept-encoding"]) {
    delete request.headers["accept-encoding"];
  }
  return request;
}`;

export interface SpaViewerRequestOptions {
  /** Product app hostname (e.g. hey.chattic.us). Enables host routing when set with marketingDomain. */
  appDomain?: string;
  /** Marketing apex hostname (e.g. chattic.us). Enables host routing when set with appDomain. */
  marketingDomain?: string;
}

/**
 * Viewer-request rewrite: global /chat SPA path, production app-domain root -> /chat,
 * then slashless SPA paths before S3 lookup (OAuth callbacks have no trailing slash).
 */
export function buildSpaViewerRequestFunction(
  options: SpaViewerRequestOptions = {},
): string {
  const { appDomain, marketingDomain } = options;
  const hostRouting =
    appDomain && marketingDomain
      ? `
  var host = request.headers.host && request.headers.host.value;
  if (host === "${appDomain}") {
    var isAuthPath = uri === "/auth/callback" || uri === "/auth/signout-callback";
    if (!isAuthPath && (uri === "/" || uri === "/index.html")) {
      request.uri = "/chat/index.html";
    }
    uri = request.uri;
  }`
      : "";

  return `function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.indexOf("/api") === 0) {
    return request;
  }${hostRouting}
  // Next's static export writes every route as <path>/index.html (except
  // the distribution root, which CloudFront's defaultRootObject already
  // resolves) -- rewrite any other extensionless path so S3 finds the
  // real object instead of 403ing, no matter how deeply nested the route
  // is (this used to be a hardcoded per-route list -- /chat, /auth/*, ...
  // -- that silently 403ed every new route, like /features/*, added
  // after it was written).
  var lastSegment = uri.substring(uri.lastIndexOf("/") + 1);
  // Metadata image routes (opengraph-image, twitter-image, ...) are real
  // static files Next writes with no extension by design -- leave them alone.
  var isMetadataImageRoute =
    lastSegment === "opengraph-image" ||
    lastSegment === "twitter-image" ||
    lastSegment === "icon" ||
    lastSegment === "apple-icon";
  if (uri !== "/" && !isMetadataImageRoute && lastSegment.indexOf(".") === -1) {
    request.uri = uri.slice(-1) === "/" ? uri + "index.html" : uri + "/index.html";
  }
  return request;
}`;
}

/** Default SPA viewer-request (no production Host split). */
export const SPA_VIEWER_REQUEST_FUNCTION = buildSpaViewerRequestFunction();

/** Rewrite S3 403/404 to 200 for the static site only (default behavior). */
export const SPA_VIEWER_RESPONSE_FUNCTION = `function handler(event) {
  var response = event.response;
  var uri = event.request.uri;
  if (uri.indexOf("/api") === 0) {
    return response;
  }
  if (response.statusCode === 403 || response.statusCode === 404) {
    response.statusCode = 200;
    response.statusDescription = "OK";
  }
  // Next's static export writes every route's opengraph-image/twitter-image
  // with no file extension, so S3/BucketDeployment can't infer its
  // content-type and serves it as application/octet-stream -- which some
  // og:image/twitter:image crawlers reject outright. Force the real type
  // for every such route, not just the site root's.
  var lastSegment = uri.substring(uri.lastIndexOf("/") + 1);
  if (lastSegment === "opengraph-image" || lastSegment === "twitter-image") {
    response.headers["content-type"] = { value: "image/png" };
  }
  return response;
}`;
