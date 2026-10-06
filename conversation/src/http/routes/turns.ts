import type { Context } from "hono";
import { getChannel } from "../../domain/channels.ts";
import {
	activeTurnForChannel,
	getTurn,
	latestTurnForChannel,
	listTurnEvents,
	type Turn,
	type TurnDependencies,
	type TurnEvent,
} from "../../domain/turns.ts";
import { pythonRepr } from "../../domain/bots.ts";
import { ChannelNotFoundError, TurnAccessDeniedError, TurnNotFoundError } from "../errors.ts";
import { isRefusal, pathParameter, resolveUserPrincipal, type UserPrincipalDependencies } from "../user-principal.ts";

/** Everything the turn routes depend on. */
export interface TurnRouteDependencies extends UserPrincipalDependencies {
	turns: TurnDependencies;
}

/** One turn as the HTTP API renders it. */
export interface TurnPayload {
	turn_id: string;
	tenant_id: string;
	channel_id: string;
	bot_id: string;
	status: string;
	waiting_for: string | null;
	pending_computer_tool: { action_id: string; tool_name: string; arguments: Record<string, string> } | null;
	terminal_reason: string | null;
	prompt_message_seq: number | null;
}

/** Render a turn for the HTTP API. */
export function turnPayload(turn: Turn): TurnPayload {
	return {
		turn_id: turn.turnId,
		tenant_id: turn.tenantId,
		channel_id: turn.channelId,
		bot_id: turn.botId,
		status: turn.status,
		waiting_for: turn.waitingFor,
		pending_computer_tool:
			turn.pendingComputerTool === null
				? null
				: {
						action_id: turn.pendingComputerTool.actionId,
						tool_name: turn.pendingComputerTool.toolName,
						arguments: { ...turn.pendingComputerTool.arguments },
					},
		terminal_reason: turn.terminalReason,
		prompt_message_seq: turn.promptMessageSeq,
	};
}

/** Render a turn event as one SSE data frame and one element of the events listing. */
export function turnEventPayload(event: TurnEvent): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		kind: event.kind,
		seq: event.seq,
		event_id: event.eventId,
		turn_id: event.turnId,
		channel_id: event.channelId,
	};
	if (event.token !== undefined) {
		payload.token = event.token;
	}
	if (event.messageSeq !== undefined) {
		payload.message_seq = event.messageSeq;
	}
	if (event.body !== undefined) {
		payload.body = event.body;
	}
	if (event.pendingComputerTool !== undefined) {
		payload.pending_computer_tool = {
			action_id: event.pendingComputerTool.actionId,
			tool_name: event.pendingComputerTool.toolName,
			arguments: { ...event.pendingComputerTool.arguments },
		};
	}
	if (event.actionId !== undefined) {
		payload.action_id = event.actionId;
	}
	if (event.attemptId !== undefined) {
		payload.attempt_id = event.attemptId;
	}
	return payload;
}

async function channelTurnHandler(
	c: Context,
	deps: TurnRouteDependencies,
	find: typeof activeTurnForChannel,
): Promise<Response> {
	const principal = await resolveUserPrincipal(c, deps);
	if (isRefusal(principal)) {
		return principal;
	}
	const tenantId = pathParameter(c, "tenant_id");
	const channelId = pathParameter(c, "channel_id");
	try {
		await getChannel(tenantId, channelId, deps);
	} catch (error) {
		if (error instanceof ChannelNotFoundError) {
			return c.json({ detail: "channel not found" }, 404);
		}
		throw error;
	}
	const botId = c.req.query("bot_id") ?? null;
	if (botId !== null && botId === "") {
		return c.json({ detail: "bot_id must not be empty" }, 422);
	}
	const turn = await find(deps.turns, tenantId, channelId, botId);
	if (turn === null) {
		return c.json({ detail: "turn not found" }, 404);
	}
	return c.json(turnPayload(turn), 200);
}

/**
 * GET /orgs/{tenant_id}/channels/{channel_id}/turn?bot_id=: the active turn of the addressed bot, or of the bot that
 * most recently started one. 404 when none is active.
 */
export async function getChannelTurnHandler(c: Context, deps: TurnRouteDependencies): Promise<Response> {
	return channelTurnHandler(c, deps, activeTurnForChannel);
}

/**
 * GET /orgs/{tenant_id}/channels/{channel_id}/turns/latest?bot_id=: the latest turn in any status of the addressed bot,
 * or across the channel's bots. 404 when the channel has had none.
 */
export async function getChannelLatestTurnHandler(c: Context, deps: TurnRouteDependencies): Promise<Response> {
	return channelTurnHandler(c, deps, latestTurnForChannel);
}

async function readableTurn(c: Context, deps: TurnRouteDependencies): Promise<Turn | Response> {
	const principal = await resolveUserPrincipal(c, deps);
	if (isRefusal(principal)) {
		return principal;
	}
	const tenantId = pathParameter(c, "tenant_id");
	const turnId = pathParameter(c, "turn_id");
	try {
		return await getTurn(deps.turns, tenantId, turnId);
	} catch (error) {
		if (error instanceof TurnNotFoundError) {
			throw new TurnAccessDeniedError(`Tenant ${pythonRepr(tenantId)} cannot read turn ${pythonRepr(turnId)}.`);
		}
		throw error;
	}
}

/** GET /orgs/{tenant_id}/turns/{turn_id}: one turn; 403 for a tenant that does not own it. */
export async function getTurnHandler(c: Context, deps: TurnRouteDependencies): Promise<Response> {
	const turn = await readableTurn(c, deps);
	if (turn instanceof Response) {
		return turn;
	}
	return c.json(turnPayload(turn), 200);
}

/** GET /orgs/{tenant_id}/turns/{turn_id}/events?after=: the turn's durable events after a sequence. */
export async function listTurnEventsHandler(c: Context, deps: TurnRouteDependencies): Promise<Response> {
	const turn = await readableTurn(c, deps);
	if (turn instanceof Response) {
		return turn;
	}
	const after = Number(c.req.query("after") ?? "0");
	if (!Number.isInteger(after) || after < 0) {
		return c.json({ detail: "after must be a non-negative integer" }, 422);
	}
	const events = await listTurnEvents(deps.turns, turn.tenantId, turn.turnId, after);
	return c.json({ events: events.map(turnEventPayload) }, 200);
}
