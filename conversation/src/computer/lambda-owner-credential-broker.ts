/**
 * The production adapter of the OwnerCredentialBroker port: it invokes the broker Lambda by function name,
 * synchronously, and validates the answer with the shared schema. Only the Front Door imports this file; the owner and
 * supervisor bundles must not, because it carries the Lambda client.
 */

import { InvokeCommand, type LambdaClient } from "@aws-sdk/client-lambda";
import { ownerCredentialBrokerRequestSchema, ownerCredentialBrokerResponseSchema } from "@chatticus/host-protocol/supervisor";
import {
	OwnerCredentialBrokerError,
	type OwnerCredentialBrokerPort,
	type SupervisorGrant,
	type SupervisorGrantRequest,
	type SupervisorRenewalGrant,
	type SupervisorRenewalGrantRequest,
	type TurnGrant,
	type TurnGrantRequest,
} from "./owner-credential-broker.ts";

/** The environment variable that names the broker Lambda for the Front Door. */
export const OWNER_CREDENTIAL_BROKER_FUNCTION_NAME_VARIABLE = "CHATTICUS_OWNER_CREDENTIAL_BROKER_FUNCTION_NAME";

/** Calls the broker Lambda with the AWS SDK. */
export class LambdaOwnerCredentialBroker implements OwnerCredentialBrokerPort {
	private readonly client: Pick<LambdaClient, "send">;
	private readonly functionName: string;

	/**
	 * @param client The Lambda client; injected so tests use a fake and the Front Door shares one.
	 * @param functionName The name or ARN of the broker function.
	 */
	constructor(client: Pick<LambdaClient, "send">, functionName: string) {
		this.client = client;
		this.functionName = functionName;
	}

	issue(request: SupervisorGrantRequest): Promise<SupervisorGrant>;
	issue(request: SupervisorRenewalGrantRequest): Promise<SupervisorRenewalGrant>;
	issue(request: TurnGrantRequest): Promise<TurnGrant>;
	async issue(
		request: SupervisorGrantRequest | SupervisorRenewalGrantRequest | TurnGrantRequest,
	): Promise<SupervisorGrant | SupervisorRenewalGrant | TurnGrant> {
		const checked = ownerCredentialBrokerRequestSchema.safeParse(request);
		if (!checked.success) {
			throw new OwnerCredentialBrokerError("invalid_request", "The broker request does not match the broker request schema, so nothing was sent.");
		}
		let payload: Uint8Array | undefined;
		try {
			const output = await this.client.send(
				new InvokeCommand({
					FunctionName: this.functionName,
					InvocationType: "RequestResponse",
					Payload: new TextEncoder().encode(JSON.stringify(checked.data)),
				}),
			);
			if (output.FunctionError !== undefined) {
				throw new OwnerCredentialBrokerError("broker_unreachable", `The broker function failed with ${output.FunctionError}.`);
			}
			if (output.StatusCode !== 200) {
				throw new OwnerCredentialBrokerError("broker_unreachable", `The broker function answered with status ${String(output.StatusCode)}.`);
			}
			payload = output.Payload;
		} catch (error) {
			if (error instanceof OwnerCredentialBrokerError) throw error;
			const name = error instanceof Error ? error.name : "UnknownError";
			throw new OwnerCredentialBrokerError("broker_unreachable", `The broker function could not be invoked (${name}).`);
		}
		const response = parseResponse(payload);
		if (!response.ok) throw new OwnerCredentialBrokerError(response.error.code, response.error.message);
		if (response.purpose !== checked.data.purpose) {
			throw new OwnerCredentialBrokerError("malformed_response", "The broker answered a grant for another purpose than the one requested.");
		}
		return response;
	}
}

function parseResponse(payload: Uint8Array | undefined): ReturnType<typeof ownerCredentialBrokerResponseSchema.parse> {
	if (payload === undefined || payload.length === 0) {
		throw new OwnerCredentialBrokerError("malformed_response", "The broker answered with an empty payload.");
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(new TextDecoder().decode(payload));
	} catch {
		throw new OwnerCredentialBrokerError("malformed_response", "The broker answered with a payload that is not JSON.");
	}
	const parsed = ownerCredentialBrokerResponseSchema.safeParse(decoded);
	if (!parsed.success) {
		throw new OwnerCredentialBrokerError("malformed_response", "The broker answered with a payload that does not match the broker response schema.");
	}
	return parsed.data;
}
