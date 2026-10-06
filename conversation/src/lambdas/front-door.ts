import { Hono } from "hono";
import { streamHandle } from "hono/aws-lambda";
import { composeFrontDoorApp } from "./front-door-composition.ts";

let composed: Promise<Hono> | null = null;

function composedApp(): Promise<Hono> {
	if (composed === null) {
		composed = composeFrontDoorApp().catch((error: unknown) => {
			composed = null;
			throw error;
		});
	}
	return composed;
}

const entry = new Hono();
entry.all("*", async (context) => (await composedApp()).fetch(context.req.raw, context.env));

/** Lambda Function URL entry point (RESPONSE_STREAM invoke mode); the real application is composed once per cold start. */
export const handler = streamHandle(entry);
