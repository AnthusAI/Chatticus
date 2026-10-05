import { streamHandle } from "hono/aws-lambda";
import { createSseProbeApp, defaultSseProbeOptions } from "../http/sse-probe.ts";

const app = createSseProbeApp(defaultSseProbeOptions);

/** Lambda Function URL entry point (RESPONSE_STREAM invoke mode). */
export const handler = streamHandle(app);
