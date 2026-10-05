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
