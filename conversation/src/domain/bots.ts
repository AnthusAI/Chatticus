import type { IdSource } from "../http/app.ts";
import { DuplicateBotNameError } from "../http/errors.ts";
import type { Bot } from "../store/codecs/bot.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import { ensureComputer } from "./computers.ts";

export { DuplicateBotNameError };
export type { Bot };

/** The bot id or name is unknown to this organization (the Python KeyError). */
export class BotNotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BotNotFoundError";
	}
}

/** What the bot functions read and write. */
export type BotDependencies = { store: MessagingStore; ids: IdSource };

/** Render a string the way Python repr does for a plain string. */
export function pythonRepr(value: string): string {
	if (value.includes("'") && !value.includes('"')) {
		return `"${value}"`;
	}
	return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * Create a named bot and ensure the organization has a computer.
 *
 * Ported from python/src/chatticus/control_plane.py lines 794-826. A replayed idempotency key returns the
 * bot stored under it.
 *
 * @throws DuplicateBotNameError If the organization already has this bot name.
 */
export async function createBot(
	tenantId: string,
	name: string,
	options: { creatorUserId: string; idempotencyKey?: string | null },
	deps: BotDependencies,
): Promise<Bot> {
	const idempotencyKey = options.idempotencyKey ?? null;
	if (idempotencyKey !== null) {
		const cached = await deps.store.getBotIdempotency(tenantId, idempotencyKey);
		if (cached !== null) {
			return cached;
		}
	}
	if ((await deps.store.getBotByName(tenantId, name)) !== null) {
		throw new DuplicateBotNameError(
			`Bot named ${pythonRepr(name)} already exists for tenant ${pythonRepr(tenantId)}.`,
		);
	}
	await ensureComputer(tenantId, deps);
	const bot: Bot = { botId: deps.ids.next(), tenantId, name, memory: {} };
	await deps.store.putBot(bot, true);
	if (idempotencyKey !== null) {
		await deps.store.putBotIdempotency(tenantId, idempotencyKey, bot);
	}
	return bot;
}

/**
 * Return one bot owned by the tenant.
 *
 * Ported from python/src/chatticus/control_plane.py lines 828-837.
 *
 * @throws BotNotFoundError If the bot is unknown to this tenant.
 */
export async function botById(tenantId: string, botId: string, deps: { store: MessagingStore }): Promise<Bot> {
	const bot = await deps.store.getBot(tenantId, botId);
	if (bot === null || bot.tenantId !== tenantId) {
		throw new BotNotFoundError(botId);
	}
	return bot;
}

/**
 * Return one bot by the organization's chosen name.
 *
 * Ported from python/src/chatticus/control_plane.py lines 839-848.
 *
 * @throws BotNotFoundError If the bot is unknown to this tenant.
 */
export async function botByName(tenantId: string, name: string, deps: { store: MessagingStore }): Promise<Bot> {
	const bot = await deps.store.getBotByName(tenantId, name);
	if (bot === null || bot.tenantId !== tenantId) {
		throw new BotNotFoundError(name);
	}
	return bot;
}

/** Return named bots in one organization, sorted by name. Ported from control_plane.py lines 850-856. */
export async function listBots(tenantId: string, deps: { store: MessagingStore }): Promise<Bot[]> {
	const owned = (await deps.store.listBots(tenantId)).filter((bot) => bot.tenantId === tenantId);
	return owned.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}
