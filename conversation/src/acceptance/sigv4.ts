/**
 * SigV4 helpers for integration-test session exchange.
 *
 * Signs requests using AWS Signature Version 4 for authentication with the
 * integration test session endpoint.
 */

import { SignatureV4 } from "@aws-sdk/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";

/**
 * Sign a request using SigV4 with the provided credentials.
 *
 * @param request - The request to sign
 * @param credentials - AWS credentials
 * @param region - AWS region
 * @param service - AWS service name
 * @returns SigV4 signed headers as a record
 */
export async function signSigV4(
	request: {
		method: string;
		url: string;
		headers: Record<string, string>;
		body?: string;
	},
	credentials: {
		accessKeyId: string;
		secretAccessKey: string;
		sessionToken?: string;
	},
	region: string,
	service: string,
): Promise<Record<string, string>> {
	const url = new URL(request.url);
	const httpRequest = new HttpRequest({
		method: request.method,
		hostname: url.hostname,
		path: url.pathname + url.search,
		headers: {
			host: url.host,
			...request.headers,
		},
		body: request.body,
	});

	const signer = new SignatureV4({
		credentials: {
			accessKeyId: credentials.accessKeyId,
			secretAccessKey: credentials.secretAccessKey,
			sessionToken: credentials.sessionToken,
		},
		region,
		service,
		sha256: Sha256,
	});

	const signed = await signer.sign(httpRequest);
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(signed.headers)) {
		if (typeof value === "string") {
			result[key] = value;
		}
	}
	return result;
}

/** URL of the STS endpoint the session exchange relays GetCallerIdentity to. */
export const STS_GET_CALLER_IDENTITY_URL = "https://sts.amazonaws.com/";
export const STS_GET_CALLER_IDENTITY_QUERY = "Action=GetCallerIdentity&Version=2011-06-15";

/** Return SigV4 headers for one unsigned STS GetCallerIdentity GET. */
export async function buildStsGetCallerIdentityHeaders(
	credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string },
	region: string = "us-east-1",
): Promise<Record<string, string>> {
	return signSigV4(
		{
			method: "GET",
			url: `${STS_GET_CALLER_IDENTITY_URL}?${STS_GET_CALLER_IDENTITY_QUERY}`,
			headers: { Host: "sts.amazonaws.com" },
		},
		credentials,
		region,
		"sts",
	);
}

/** Return the SigV4 canonical query string for `params`. */
export function canonicalQueryString(params: Record<string, string>): string {
	const encode = (value: string): string =>
		encodeURIComponent(value).replace(
			/[!'()*]/g,
			(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
		);
	return Object.keys(params)
		.sort()
		.map((key) => `${encode(key)}=${encode(params[key] as string)}`)
		.join("&");
}
