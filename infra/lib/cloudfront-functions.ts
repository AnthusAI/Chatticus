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
