import { createHash } from "node:crypto";
import { createKanbusApiClient, type KanbusApiClient, type KanbusFetch } from "@kanbus/api-client";
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
		fetch: options.fetch,
		headers: () => ({ [KANBUS_ACTOR_HEADER]: options.actor }),
	});
}
