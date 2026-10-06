import { Hono } from "hono";
import { streamHandle } from "hono/aws-lambda";
import { createSseProbeApp, defaultSseProbeOptions } from "../http/sse-probe.ts";
import { resolveOpenAiApiKey } from "./openai-key.ts";

const app = new Hono();
app.use(async (_context, next) => {
	await resolveOpenAiApiKey();
	await next();
});
app.route("/", createSseProbeApp(defaultSseProbeOptions));

/** Lambda Function URL entry point (RESPONSE_STREAM invoke mode). */
export const handler = streamHandle(app);
