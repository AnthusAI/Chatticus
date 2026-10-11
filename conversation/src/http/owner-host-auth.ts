import { parseBearerToken } from "../auth/principal.ts";
import type { TurnControlStore } from "../domain/turns.ts";
import { verifySessionToken } from "../gateway/session-token.ts";

/**
 * Why a container owner is authenticated on the host routes by a signed token and not by the shared invoke key.
 *
 * The invoke key is one value for the whole deployment. A container that held it could register as a worker of any
 * organization and use every host route of that organization, so one compromised owner would be a breach of all of them.
 * The owner instead holds a token the starter signed for exactly this owner: it names the organization, the bot, the turn,
 * the owner id and the host start generation, it expires in an hour, and it is minted for the `owner-host` audience, so the
 * token that reaches the model gateway cannot be replayed here. The token is accepted only on the fixed list of routes the
 * owner calls, and on those routes only for the organization it names while no other owner has taken its turn over.
 */

/** One host route a container owner may call with its token, named by method and by the path after `/orgs/{tenant_id}/host`. */
export type OwnerHostRoute = { readonly method: "GET" | "POST"; readonly suffix: string };

/**
 * Every route the owner token opens. Nothing else accepts it: not the action routes (the owner runs its tools itself),
 * not worker registration (the starter registers the owner), not another organization's routes, not the operator routes.
 */
export const OWNER_HOST_ROUTES: readonly OwnerHostRoute[] = [
	{ method: "GET", suffix: "/computer" },
	{ method: "POST", suffix: "/computer/state" },
	{ method: "POST", suffix: "/snapshot/hydrated" },
	{ method: "POST", suffix: "/snapshot/published" },
	{ method: "POST", suffix: "/heartbeat" },
];

/** Who a verified owner token speaks for on the host routes. */
export type OwnerHostPrincipal = {
	readonly tenantId: string;
	readonly turnId: string;
	readonly ownerId: string;
	readonly startGeneration: number;
};

/** What the owner token check decided about a request. */
export type OwnerHostDecision =
	| { readonly kind: "not_owner_request" }
	| { readonly kind: "authenticated"; readonly principal: OwnerHostPrincipal }
	| { readonly kind: "refused"; readonly status: 401 | 403; readonly detail: string };

/** What verifying an owner token needs: the signing key, the clock and the turn records. */
export type OwnerHostAuthDependencies = {
	readonly signingKey: string;
	readonly clock: { now(): Date };
	readonly turns: Pick<TurnControlStore, "getTurn">;
};

const SESSION_TOKEN_PREFIX = "ct1.";
const HOST_PATH = /^\/orgs\/([^/]+)\/host(\/.*)$/;
const GATEWAY_PATH = /^\/orgs\/[^/]+\/model-gateway\/v1\/responses$/;

/**
 * Whether a request is the model gateway call, the one route that authenticates itself by its own token.
 *
 * @param method The HTTP method.
 * @param path The request path.
 * @returns True for POST /orgs/{tenant_id}/model-gateway/v1/responses.
 */
export function isModelGatewayRequest(method: string, path: string): boolean {
	return method === "POST" && GATEWAY_PATH.test(path);
}

function ownerRouteTenant(method: string, path: string): string | null {
	const match = HOST_PATH.exec(path);
	if (match === null) return null;
	const [, tenantSegment, suffix] = match as unknown as [string, string, string];
	return OWNER_HOST_ROUTES.some((route) => route.method === method && route.suffix === suffix) ? tenantSegment : null;
}

const principals = new WeakMap<Request, OwnerHostPrincipal>();

/**
 * Remember which owner an authenticated request belongs to. Only the front door's own token check calls this, so the
 * answer cannot be forged by a header.
 *
 * @param request The request.
 * @param principal The verified owner.
 */
export function rememberOwnerHostPrincipal(request: Request, principal: OwnerHostPrincipal): void {
	principals.set(request, principal);
}

/**
 * The owner a request was authenticated as, or null when the request carries no verified owner token.
 *
 * @param request The request.
 * @returns The owner, or null.
 */
export function ownerHostPrincipalOf(request: Request): OwnerHostPrincipal | null {
	return principals.get(request) ?? null;
}

const refusal = (status: 401 | 403, detail: string): OwnerHostDecision => ({ kind: "refused", status, detail });

function safelyDecoded(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return "";
	}
}

/**
 * Authenticate a request as a container owner. A request is an owner request when it carries a session token and names one
 * of {@link OWNER_HOST_ROUTES}; anything else is not an owner request and needs the invoke key as before. For an owner
 * request the token must be signed, unexpired and minted for the `owner-host` audience (401 otherwise); it must name the
 * organization of the path, the turn must exist for the token's bot, and no other owner may hold the turn's claim (403
 * otherwise). The turn need not be claimed yet, because the owner hydrates its disk before it claims, and it may be
 * finished, because the owner reports its disk after the turn ends.
 *
 * @param deps The signing key, clock and turn records.
 * @param request The method, path and Authorization header value.
 * @returns Not an owner request, the verified owner, or the refusal to answer with.
 */
export async function authenticateOwnerHostRequest(
	deps: OwnerHostAuthDependencies,
	request: { readonly method: string; readonly path: string; readonly authorization: string | null },
): Promise<OwnerHostDecision> {
	const token = parseBearerToken(request.authorization);
	if (token === null || !token.startsWith(SESSION_TOKEN_PREFIX)) return { kind: "not_owner_request" };
	const tenantSegment = ownerRouteTenant(request.method, request.path);
	if (tenantSegment === null) return { kind: "not_owner_request" };
	const verification = verifySessionToken(deps.signingKey, token, deps.clock.now(), "owner-host");
	if (!verification.valid) return refusal(401, "invalid owner credential");
	const { claims } = verification;
	if (claims.tenantId !== tenantSegment || safelyDecoded(tenantSegment) !== tenantSegment) {
		return refusal(403, "owner credential is not valid for this organization");
	}
	const turn = await deps.turns.getTurn(claims.tenantId, claims.turnId);
	if (turn === null || turn.botId !== claims.botId) return refusal(403, "owner credential is not valid for a turn of this organization");
	if (turn.claimedBy !== null && turn.claimedBy !== claims.ownerId) return refusal(403, "another owner holds the turn");
	return {
		kind: "authenticated",
		principal: { tenantId: claims.tenantId, turnId: claims.turnId, ownerId: claims.ownerId, startGeneration: claims.startGeneration },
	};
}
