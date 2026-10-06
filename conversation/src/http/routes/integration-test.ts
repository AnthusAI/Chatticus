import type { Context } from "hono";
import { createIntegrationTestSessionResponse, type IntegrationTestAuthConfig } from "../../auth/integration-test.ts";

/** POST /integration-test/session: exchange one verified IAM caller for a short-lived integration bearer token. */
export async function integrationTestSessionHandler(c: Context, config: IntegrationTestAuthConfig): Promise<Response> {
	return c.json(await createIntegrationTestSessionResponse(c.req.raw, config), 200);
}
