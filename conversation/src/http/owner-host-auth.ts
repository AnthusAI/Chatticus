import { OWNER_ERROR_STATUS, type OwnerErrorCode } from "@chatticus/host-protocol/supervisor";
import { parseBearerToken } from "../auth/principal.ts";
import type { OwnerIdentity } from "../domain/owner-supervisor.ts";
import { verifyComputerOwnerToken } from "../gateway/session-token.ts";
import type { MessagingStore } from "../store/messaging-store.ts";

/**
 * Why a container owner is authenticated on the owner routes by a signed supervisor token and not by the shared invoke key.
 *
 * The invoke key is one value for the whole deployment. A container that held it could register as a worker of any
 * organization and use every host route of that organization, so one compromised owner would be a breach of all of them.
 * The supervisor instead holds a token the credential broker signed for exactly this owner: it names the organization, the
 * computer, the owner id and the host start generation, it expires in an hour, and it is minted for the `computer-owner`
 * audience, so neither the token that reaches the model gateway nor the bootstrap token can be replayed here. The token is
 * accepted only on the fixed list of routes the supervisor calls, only for the organization it names, and only while its
 * owner is the current owner of the current host start generation.
 */

/** One route a supervisor may call with its token, named by method and by the path after `/orgs/{tenant_id}/host`. */
export type OwnerComputerRoute = { readonly method: "GET" | "POST"; readonly suffix: string };

/**
 * Every route the supervisor token opens. Nothing else accepts it: not the action routes (the child runs its tools itself),
 * not the heartbeat (the poll is the heartbeat), not worker registration, not another organization's routes, not the
 * operator routes.
 */
export const OWNER_COMPUTER_ROUTES: readonly OwnerComputerRoute[] = [
	{ method: "GET", suffix: "/computer" },
	{ method: "POST", suffix: "/computer/state" },
	{ method: "POST", suffix: "/snapshot/hydrated" },
	{ method: "POST", suffix: "/snapshot/published" },
	{ method: "POST", suffix: "/owner/poll" },
	{ method: "POST", suffix: "/owner/stop-request" },
	{ method: "POST", suffix: "/owner/credentials" },
	{ method: "POST", suffix: "/owner/file-results" },
	{ method: "POST", suffix: "/owner/overlay-seal" },
	{ method: "POST", suffix: "/owner/overlay-applied" },
];

/** The route that exchanges a bootstrap token. It is matched separately because it takes another audience. */
export const OWNER_BOOTSTRAP_ROUTE: OwnerComputerRoute = { method: "POST", suffix: "/owner/bootstrap" };

/** Who a verified supervisor token speaks for on the owner routes. */
export type ComputerOwnerPrincipal = OwnerIdentity;

/** What the supervisor token check decided about a request. */
export type OwnerHostDecision =
	| { readonly kind: "not_owner_request" }
	| { readonly kind: "bootstrap_request" }
	| { readonly kind: "authenticated"; readonly principal: ComputerOwnerPrincipal }
	| { readonly kind: "refused"; readonly status: 401 | 403; readonly code: OwnerErrorCode; readonly detail: string };

/** What verifying a supervisor token needs: the signing key, the clock and the computer record. */
export type OwnerHostAuthDependencies = {
	readonly signingKey: string;
	readonly clock: { now(): Date };
	readonly store: Pick<MessagingStore, "getComputer">;
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

function hostRoute(method: string, path: string): { tenantSegment: string; suffix: string } | null {
	const match = HOST_PATH.exec(path);
	if (match === null) return null;
	const [, tenantSegment, suffix] = match as unknown as [string, string, string];
	return { tenantSegment, suffix };
}

const principals = new WeakMap<Request, ComputerOwnerPrincipal>();
const bootstrapRequests = new WeakSet<Request>();

/**
 * Remember which owner an authenticated request belongs to. Only the front door's own token check calls this, so the
 * answer cannot be forged by a header.
 *
 * @param request The request.
 * @param principal The verified owner.
 */
export function rememberOwnerHostPrincipal(request: Request, principal: ComputerOwnerPrincipal): void {
	principals.set(request, principal);
}

/**
 * The owner a request was authenticated as, or null when the request carries no verified supervisor token.
 *
 * @param request The request.
 * @returns The owner, or null.
 */
export function ownerHostPrincipalOf(request: Request): ComputerOwnerPrincipal | null {
	return principals.get(request) ?? null;
}

/**
 * Remember that a request carries a bootstrap-looking token on the bootstrap route, so the invoke key gate lets it
 * through to the handler, which verifies the token itself.
 *
 * @param request The request.
 */
export function rememberBootstrapRequest(request: Request): void {
	bootstrapRequests.add(request);
}

/**
 * Whether the front door decided the request is a bootstrap exchange attempt.
 *
 * @param request The request.
 * @returns True after {@link rememberBootstrapRequest}.
 */
export function isBootstrapRequest(request: Request): boolean {
	return bootstrapRequests.has(request);
}

const refusal = (code: OwnerErrorCode, detail: string): OwnerHostDecision => ({
	kind: "refused",
	status: OWNER_ERROR_STATUS[code] as 401 | 403,
	code,
	detail,
});

function safelyDecoded(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return "";
	}
}

/**
 * Authenticate a request as the supervisor of a computer owner. A request is an owner request when it carries a session
 * token and names one of {@link OWNER_COMPUTER_ROUTES}; the bootstrap route is recognised separately and left to its
 * handler; anything else needs the invoke key as before. For an owner request, in order and first failure wins: the token
 * must be signed, unexpired and minted for the `computer-owner` audience (401); it must name the organization of the path
 * (403); the organization must have a computer, the one the token names (403 `not_current_owner`); the computer's host
 * start generation must be the token's (403 `stale_generation`); and the token's owner must be the computer's owner of
 * that generation (403 `not_current_owner`). One exception makes the stopped report safe to repeat when its response was
 * lost: on a computer that is stopped and records no owner for that same generation, `POST /computer/state` is let
 * through, and its handler accepts only the stopped report.
 *
 * @param deps The signing key, clock and computer record.
 * @param request The method, path and Authorization header value.
 * @returns Not an owner request, the bootstrap exchange, the verified owner, or the refusal to answer with.
 */
export async function authenticateOwnerHostRequest(
	deps: OwnerHostAuthDependencies,
	request: { readonly method: string; readonly path: string; readonly authorization: string | null },
): Promise<OwnerHostDecision> {
	const token = parseBearerToken(request.authorization);
	if (token === null || !token.startsWith(SESSION_TOKEN_PREFIX)) return { kind: "not_owner_request" };
	const route = hostRoute(request.method, request.path);
	if (route === null) return { kind: "not_owner_request" };
	if (request.method === OWNER_BOOTSTRAP_ROUTE.method && route.suffix === OWNER_BOOTSTRAP_ROUTE.suffix) return { kind: "bootstrap_request" };
	if (!OWNER_COMPUTER_ROUTES.some((candidate) => candidate.method === request.method && candidate.suffix === route.suffix)) {
		return { kind: "not_owner_request" };
	}
	const verification = verifyComputerOwnerToken(deps.signingKey, token, deps.clock.now());
	if (!verification.valid) return refusal("invalid_credential", "invalid owner credential");
	const { claims } = verification;
	if (claims.tenantId !== route.tenantSegment || safelyDecoded(route.tenantSegment) !== route.tenantSegment) {
		return refusal("wrong_organization", "owner credential is not valid for this organization");
	}
	const computer = await deps.store.getComputer(claims.tenantId);
	if (computer === null || computer.computerId !== claims.computerId) {
		return refusal("not_current_owner", "owner credential is not valid for the current owner of this computer");
	}
	if (computer.hostStartGeneration !== claims.startGeneration) {
		return refusal("stale_generation", "owner credential is not valid for this host start generation");
	}
	const principal: ComputerOwnerPrincipal = {
		tenantId: claims.tenantId,
		computerId: claims.computerId,
		ownerId: claims.ownerId,
		startGeneration: claims.startGeneration,
		token,
	};
	if (computer.ownerId === claims.ownerId && computer.ownerGeneration === claims.startGeneration) {
		return { kind: "authenticated", principal };
	}
	const stoppedReplay =
		request.method === "POST" &&
		route.suffix === "/computer/state" &&
		computer.stopped &&
		computer.ownerId === undefined &&
		computer.ownerGeneration === claims.startGeneration;
	if (stoppedReplay) return { kind: "authenticated", principal };
	return refusal("not_current_owner", "owner credential is not valid for the current owner of this computer");
}
