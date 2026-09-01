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

/** Rewrite slashless SPA paths before S3 lookup (OAuth callback has no trailing slash). */
export const SPA_VIEWER_REQUEST_FUNCTION = `function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.indexOf("/api") === 0) {
    return request;
  }
  if (uri === "/auth/callback") {
    request.uri = "/auth/callback/index.html";
  }
  return request;
}`;

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
  return response;
}`;
