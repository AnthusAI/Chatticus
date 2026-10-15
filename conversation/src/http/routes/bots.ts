import type { Context } from "hono";
import { BotNotFoundError, botById, botByName, createBot, listBots } from "../../domain/bots.ts";
import type { Bot } from "../../domain/bots.ts";
import type { MessagingStore } from "../../store/messaging-store.ts";
import type { IdSource } from "../app.ts";
import { isRefusal, pathParameter, resolveUserPrincipal, type UserPrincipalDependencies } from "../user-principal.ts";

/** Everything the bot routes depend on. */
export interface BotRouteDependencies extends UserPrincipalDependencies {
	store: MessagingStore;
	ids: IdSource;
}

/** One bot as the HTTP API renders it. */
export interface BotPayload {
	bot_id: string;
	tenant_id: string;
	name: string;
	memory: Record<string, string>;
}

/** Render a bot for the HTTP API. */
export function botPayload(bot: Bot): BotPayload {
	return { bot_id: bot.botId, tenant_id: bot.tenantId, name: bot.name, memory: { ...bot.memory } };
}

/** POST /orgs/{tenant_id}/bots: an enabled member creates a named bot, replaying an Idempotency-Key. */
export async function createBotHandler(c: Context, deps: BotRouteDependencies): Promise<Response> {
	const principal = await resolveUserPrincipal(c, deps);
	if (isRefusal(principal)) {
		return principal;
	}
	if (principal.userId === null) {
		return c.json({ detail: "user credential required" }, 403);
	}
	const requestBody = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
	if (requestBody === null || typeof requestBody.name !== "string") {
		return c.json({ detail: "name is required" }, 422);
	}
	const name = requestBody.name.trim();
	if (name === "") {
		return c.json({ detail: "bot name is required" }, 400);
	}
	const idempotencyKey = (c.req.header("Idempotency-Key") ?? "").trim() || null;
	const bot = await createBot(
		pathParameter(c, "tenant_id"),
		name,
		{ creatorUserId: principal.userId, idempotencyKey },
		deps,
	);
	return c.json(botPayload(bot), 200);
}

/** GET /orgs/{tenant_id}/bots?name=: look one bot up by its organization name. */
export async function lookupBotHandler(c: Context, deps: BotRouteDependencies): Promise<Response> {
	const principal = await resolveUserPrincipal(c, deps);
	if (isRefusal(principal)) {
		return principal;
	}
	const name = c.req.query("name");
	if (name === undefined) {
		return c.json({ detail: "name is required" }, 422);
	}
	try {
		return c.json(botPayload(await botByName(pathParameter(c, "tenant_id"), name, deps)), 200);
	} catch (error) {
		if (error instanceof BotNotFoundError) {
			return c.json({ detail: "bot not found" }, 404);
		}
		throw error;
	}
}

/** GET /orgs/{tenant_id}/users/{user_id}/bots: the organization's bots, sorted by name. */
export async function listUserBotsHandler(c: Context, deps: BotRouteDependencies): Promise<Response> {
	const principal = await resolveUserPrincipal(c, deps);
	if (isRefusal(principal)) {
		return principal;
	}
	const bots = await listBots(pathParameter(c, "tenant_id"), deps);
	return c.json({ bots: bots.map(botPayload) }, 200);
}

/** GET /orgs/{tenant_id}/bots/{bot_id}: one bot by identifier. */
export async function getBotHandler(c: Context, deps: BotRouteDependencies): Promise<Response> {
	const principal = await resolveUserPrincipal(c, deps);
	if (isRefusal(principal)) {
		return principal;
	}
	try {
		return c.json(botPayload(await botById(pathParameter(c, "tenant_id"), pathParameter(c, "bot_id"), deps)), 200);
	} catch (error) {
		if (error instanceof BotNotFoundError) {
			return c.json({ detail: "bot not found" }, 404);
		}
		throw error;
	}
}
