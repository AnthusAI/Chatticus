import { createHash } from "node:crypto";
import { createKanbusApiClient, type KanbusApiClient, type KanbusFetch } from "@kanbus/api-client";
import { BoardServiceUncodedResponseError, excerptOfResponseBody } from "./board-failures.ts";
import { formatLogLine } from "../observability/log-line.ts";
import { signSigV4 } from "../acceptance/sigv4.ts";

/** Names the environment variable that holds the Kanbus board service URL. Present only where the board capability is rolled out. */
export const KANBUS_API_URL_VARIABLE = "CHATTICUS_KANBUS_API_URL";

/** The header the Kanbus service reads the acting person or bot from when the caller is a delegating service principal. */
export const KANBUS_ACTOR_HEADER = "X-Kanbus-Actor";

const KANBUS_SERVICE_SIGNING_NAME = "execute-api";

/** AWS credentials as the SDK credential providers return them. */
export type BoardServiceCredentials = {
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	readonly sessionToken?: string;
};

/**
 * The board service URL from the environment.
 *
 * @param environment The process environment.
 * @returns The URL, or null when the board capability is not rolled out in this environment.
 */
export function kanbusApiUrlFrom(environment: Record<string, string | undefined>): string | null {
	const url = environment[KANBUS_API_URL_VARIABLE];
	return url === undefined || url === "" ? null : url;
}

function headerRecordOf(headers: RequestInit["headers"]): Record<string, string> {
	const record: Record<string, string> = {};
	if (headers === undefined) return record;
	new Headers(headers).forEach((value, name) => {
		record[name] = value;
	});
	return record;
}

/**
 * A fetch that signs each request with SigV4 for the API Gateway `execute-api` service, using the credentials the
 * function's role holds at the moment of the request. The Kanbus client does the rest; it never signs.
 *
 * @param options The credential provider, the region and, for tests, the fetch that carries the signed request.
 * @returns A fetch for `createKanbusApiClient`.
 */
export function createSigV4SignedFetch(options: {
	readonly credentials: () => Promise<BoardServiceCredentials>;
	readonly region: string;
	readonly fetch?: KanbusFetch;
}): KanbusFetch {
	const carrier: KanbusFetch = options.fetch ?? ((input, init) => fetch(input, init));
	return async (input, init = {}) => {
		const body = typeof init.body === "string" ? init.body : "";
		const signedHeaders = await signSigV4(
			{
				method: init.method ?? "GET",
				url: input,
				headers: { ...headerRecordOf(init.headers), "x-amz-content-sha256": createHash("sha256").update(body).digest("hex") },
				...(body === "" ? {} : { body }),
			},
			await options.credentials(),
			options.region,
			KANBUS_SERVICE_SIGNING_NAME,
		);
		return carrier(input, { ...init, headers: signedHeaders });
	};
}

/**
 * The request path with the tenant and project segments masked, so a log line names the route and not the board. The
 * tenant and project are the two segments before the first `api` segment; any stage prefix before them is kept.
 *
 * @param url The full request URL.
 * @returns For example `/prod/{tenant}/{project}/api/config`, or `/{unrecognized route}` when the path has no `api` segment.
 */
export function maskedRoutePathOf(url: string): string {
	const segments = new URL(url).pathname.split("/");
	const apiIndex = segments.findIndex((segment, index) => index >= 3 && segment === "api");
	if (apiIndex === -1) return "/{unrecognized route}";
	return [...segments.slice(0, apiIndex - 2), "{tenant}", "{project}", ...segments.slice(apiIndex)].join("/");
}

/**
 * A fetch that turns an error response without a Kanbus error `code` into a {@link BoardServiceUncodedResponseError}
 * and logs it at error level with the method, the masked path, the status and the first 200 characters of the body.
 * Kanbus always sends a code, so such a response came from something in front of Kanbus.
 *
 * @param carrier The fetch that sends the request.
 * @returns A fetch for `createKanbusApiClient`.
 */
export function withUncodedResponseDetection(carrier: KanbusFetch): KanbusFetch {
	return async (input, init = {}) => {
		const response = await carrier(input, init);
		if (response.ok) return response;
		const text = await response.clone().text();
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = undefined;
		}
		const code = typeof parsed === "object" && parsed !== null ? (parsed as { error?: unknown }).error : undefined;
		if (typeof code === "string" && code !== "") return response;
		const excerpt = excerptOfResponseBody(text);
		console.error(
			formatLogLine("board_service_uncoded_response", {
				method: (init.method ?? "GET").toUpperCase(),
				path: maskedRoutePathOf(input),
				status: response.status,
				body: excerpt,
			}),
		);
		throw new BoardServiceUncodedResponseError(response.status, excerpt);
	};
}

/**
 * The Kanbus client for one acting person or bot. The actor header travels on every request, reads and provisioning
 * included, because a delegating service principal must send it on all of them; writes also pass the actor to the
 * client as its documentation asks.
 *
 * @param options The service URL, the fetch that signs and sends, and the actor header value.
 * @returns A client that speaks as that actor.
 */
export function createBoardClientForActor(options: {
	readonly baseUrl: string;
	readonly fetch: KanbusFetch;
	readonly actor: string;
}): KanbusApiClient {
	return createKanbusApiClient({
		baseUrl: options.baseUrl,
		fetch: withUncodedResponseDetection(options.fetch),
		headers: () => ({ [KANBUS_ACTOR_HEADER]: options.actor }),
	});
}
