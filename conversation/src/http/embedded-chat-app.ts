import { Hono } from "hono";
import type { Principal } from "../auth/principal.ts";
import type { MessageDependencies } from "../domain/messages.ts";
import type { TurnDependencies } from "../domain/turns.ts";
import { PrincipalHttpError } from "../auth/principal.ts";
import { DomainError, statusFor } from "./errors.ts";
import type { Clock } from "./app.ts";
import { createUserMembershipCache } from "./user-principal.ts";
import { listChannelMessagesHandler, postChannelMessageHandler } from "./routes/messages.ts";
import { listTurnEventsHandler, type TurnRouteDependencies } from "./routes/turns.ts";
import { OpenStreamCounter, streamTurnHandler } from "./routes/turn-stream.ts";
import { DEFAULT_STREAM_TIMING, wallStreamClock, type StreamClock, type StreamTiming } from "./stream.ts";

export type HostedPrincipalResolver = (request: Request) => Promise<Principal | null>;

export interface EmbeddedChatAppDependencies {
	clock: Clock;
	messages: MessageDependencies;
	turns: TurnDependencies;
	resolvePrincipal: HostedPrincipalResolver;
	streamTiming?: StreamTiming;
	streamClock?: StreamClock;
	openStreams?: OpenStreamCounter;
}

/**
 * Build the host-facing slice of the Chatticus server from its production message and turn domain dependencies.
 * The host owns authentication and must return a principal with tenantId/userId already derived from trusted state.
 */
export function createEmbeddedChatApp(deps: EmbeddedChatAppDependencies): Hono {
	const app = new Hono();
	const principalDependencies = {
		store: deps.messages.store,
		verifier: null,
		membershipCache: createUserMembershipCache(deps.clock),
		integrationTest: null,
		resolveHostPrincipal: deps.resolvePrincipal,
	};
	const messageRoutes = {
		...principalDependencies,
		messages: deps.messages,
		tenantIdForPrincipal: (principal: Principal) => principal.tenantId,
	};
	const turnRoutes: TurnRouteDependencies = {
		...principalDependencies,
		turns: deps.turns,
		tenantIdForPrincipal: (principal: Principal) => principal.tenantId,
	};

	app.onError((error, context) => {
		if (error instanceof DomainError) return context.json({ detail: error.message }, statusFor(error) as never);
		if (error instanceof PrincipalHttpError) return context.json({ detail: error.detail }, error.status as never);
		throw error;
	});
	app.post("/channels/:channel_id/messages", (context) => postChannelMessageHandler(context, messageRoutes));
	app.get("/channels/:channel_id/messages", (context) => listChannelMessagesHandler(context, messageRoutes));
	app.get("/turns/:turn_id/events", (context) => listTurnEventsHandler(context, turnRoutes));
	app.get("/turns/:turn_id/stream", (context) => streamTurnHandler(context, {
		...turnRoutes,
		streamTiming: deps.streamTiming ?? DEFAULT_STREAM_TIMING,
		streamClock: deps.streamClock ?? wallStreamClock,
		openStreams: deps.openStreams ?? new OpenStreamCounter(),
	}));
	return app;
}
