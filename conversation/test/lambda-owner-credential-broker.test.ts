import { InvokeCommand, type LambdaClient } from "@aws-sdk/client-lambda";
import type { OwnerCredentialBrokerRequest } from "@chatticus/host-protocol/supervisor";
import { describe, expect, it } from "vitest";
import { LambdaOwnerCredentialBroker } from "../src/computer/lambda-owner-credential-broker.ts";
import { OwnerCredentialBrokerError } from "../src/computer/owner-credential-broker.ts";

type InvokeOutput = { StatusCode?: number; FunctionError?: string; Payload?: Uint8Array };

class FakeLambdaClient {
	readonly commands: InvokeCommand[] = [];
	private readonly answer: () => InvokeOutput | Error;

	constructor(answer: () => InvokeOutput | Error) {
		this.answer = answer;
	}

	async send(command: InvokeCommand): Promise<InvokeOutput> {
		this.commands.push(command);
		const result = this.answer();
		if (result instanceof Error) throw result;
		return result;
	}
}

const credentials = {
	access_key_id: "ASIAEXAMPLE",
	secret_access_key: "secret",
	session_token: "session",
	expires_at: "2026-10-07T13:00:00.000Z",
};

const supervisorRequest: Extract<OwnerCredentialBrokerRequest, { purpose: "supervisor" }> = {
	version: 1,
	purpose: "supervisor",
	tenant_id: "anthus",
	computer_id: "computer-1",
	owner_id: "owner-1",
	generation: 2,
	authorization: "ct1.bootstrap.token",
};

const turnRequest: Extract<OwnerCredentialBrokerRequest, { purpose: "turn" }> = {
	...supervisorRequest,
	purpose: "turn",
	authorization: "ct1.supervisor.token",
	turn: { turn_id: "turn-1", bot_id: "bot-1", channel_id: "channel-1" },
};

const supervisorGrant = {
	ok: true,
	purpose: "supervisor",
	aws_credentials: credentials,
	supervisor_token: "ct1.new.supervisor",
	supervisor_token_expires_at: "2026-10-07T13:00:00.000Z",
};

const renewalRequest: Extract<OwnerCredentialBrokerRequest, { purpose: "supervisor_renewal" }> = {
	...supervisorRequest,
	purpose: "supervisor_renewal",
	authorization: "ct1.supervisor.token",
};

const renewalGrant = { ...supervisorGrant, purpose: "supervisor_renewal" };

const turnGrant = { ok: true, purpose: "turn", aws_credentials: credentials, gateway_token: "ct1.gateway", expires_at: "2026-10-07T13:00:00.000Z" };

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

function brokerAnswering(answer: () => InvokeOutput | Error): { broker: LambdaOwnerCredentialBroker; client: FakeLambdaClient } {
	const client = new FakeLambdaClient(answer);
	return { broker: new LambdaOwnerCredentialBroker(client as unknown as Pick<LambdaClient, "send">, "owner-credential-broker-fn"), client };
}

describe("LambdaOwnerCredentialBroker", () => {
	it("invokes the function by name synchronously with the request as JSON and returns the supervisor grant", async () => {
		const { broker, client } = brokerAnswering(() => ({ StatusCode: 200, Payload: bytes(supervisorGrant) }));
		const grant = await broker.issue(supervisorRequest);
		expect(grant).toEqual(supervisorGrant);
		expect(client.commands).toHaveLength(1);
		expect(client.commands[0]).toBeInstanceOf(InvokeCommand);
		const input = client.commands[0]!.input;
		expect(input.FunctionName).toBe("owner-credential-broker-fn");
		expect(input.InvocationType).toBe("RequestResponse");
		expect(JSON.parse(new TextDecoder().decode(input.Payload as Uint8Array))).toEqual(supervisorRequest);
	});

	it("returns the supervisor renewal grant and refuses a bootstrap grant answered to it", async () => {
		const renewing = brokerAnswering(() => ({ StatusCode: 200, Payload: bytes(renewalGrant) }));
		expect(await renewing.broker.issue(renewalRequest)).toEqual(renewalGrant);
		const confused = brokerAnswering(() => ({ StatusCode: 200, Payload: bytes(supervisorGrant) }));
		await expect(confused.broker.issue(renewalRequest)).rejects.toMatchObject({ code: "malformed_response" });
	});

	it("throws owner_lifetime_over as the broker's own code", async () => {
		const { broker } = brokerAnswering(() => ({
			StatusCode: 200,
			Payload: bytes({ ok: false, error: { code: "owner_lifetime_over", message: "The owner is within the minimum session of its hard lifetime, or past it." } }),
		}));
		await expect(broker.issue(renewalRequest)).rejects.toMatchObject({ name: "OwnerCredentialBrokerError", code: "owner_lifetime_over" });
	});

	it("returns the turn grant", async () => {
		const { broker } = brokerAnswering(() => ({ StatusCode: 200, Payload: bytes(turnGrant) }));
		expect(await broker.issue(turnRequest)).toEqual(turnGrant);
	});

	it("throws the broker's own code for ok false", async () => {
		const { broker } = brokerAnswering(() => ({
			StatusCode: 200,
			Payload: bytes({ ok: false, error: { code: "authorization_mismatch", message: "The token names another owner." } }),
		}));
		await expect(broker.issue(supervisorRequest)).rejects.toMatchObject({ name: "OwnerCredentialBrokerError", code: "authorization_mismatch" });
	});

	it("maps a function error to broker_unreachable without echoing the payload", async () => {
		const { broker } = brokerAnswering(() => ({ StatusCode: 200, FunctionError: "Unhandled", Payload: bytes({ errorMessage: "secret-token-value" }) }));
		const failure = await broker.issue(turnRequest).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(OwnerCredentialBrokerError);
		expect((failure as OwnerCredentialBrokerError).code).toBe("broker_unreachable");
		expect((failure as OwnerCredentialBrokerError).message).toContain("Unhandled");
		expect((failure as OwnerCredentialBrokerError).message).not.toContain("secret-token-value");
	});

	it("maps a thrown client error to broker_unreachable", async () => {
		const { broker } = brokerAnswering(() => new Error("connect ETIMEDOUT"));
		await expect(broker.issue(supervisorRequest)).rejects.toMatchObject({ code: "broker_unreachable" });
	});

	it("maps a status other than 200 to broker_unreachable", async () => {
		const { broker } = brokerAnswering(() => ({ StatusCode: 500, Payload: bytes(supervisorGrant) }));
		await expect(broker.issue(supervisorRequest)).rejects.toMatchObject({ code: "broker_unreachable" });
	});

	it.each([
		["an empty payload", () => ({ StatusCode: 200 })],
		["a payload that is not JSON", () => ({ StatusCode: 200, Payload: new TextEncoder().encode("<html>") })],
		["a payload that is not a response", () => ({ StatusCode: 200, Payload: bytes({ ok: true, purpose: "supervisor" }) })],
		["a grant of the other purpose", () => ({ StatusCode: 200, Payload: bytes(turnGrant) })],
	])("maps %s to malformed_response", async (_name, answer) => {
		const { broker } = brokerAnswering(answer);
		await expect(broker.issue(supervisorRequest)).rejects.toMatchObject({ code: "malformed_response" });
	});

	it("refuses a request the schema refuses before invoking anything", async () => {
		const { broker, client } = brokerAnswering(() => ({ StatusCode: 200, Payload: bytes(supervisorGrant) }));
		await expect(broker.issue({ ...supervisorRequest, generation: 0 })).rejects.toMatchObject({ code: "invalid_request" });
		await expect(broker.issue({ ...supervisorRequest, extra: true } as never)).rejects.toMatchObject({ code: "invalid_request" });
		expect(client.commands).toHaveLength(0);
	});
});
