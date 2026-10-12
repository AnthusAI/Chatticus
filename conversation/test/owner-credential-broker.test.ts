import type { AssumeRoleCommand } from "@aws-sdk/client-sts";
import type { OwnerCredentialBrokerRequest } from "@chatticus/host-protocol/supervisor";
import { describe, expect, it } from "vitest";
import { mintOwnerBootstrapToken } from "../src/gateway/session-token.ts";
import { BROKER_SIGNING_KEY_CACHE_SECONDS, createOwnerCredentialBrokerHandler } from "../src/lambdas/owner-credential-broker.ts";

const SIGNING_KEY = "unit-test-signing-key-".padEnd(48, "k");
const START = new Date("2026-10-12T12:00:00Z");

function harness(ownerId = "owner-1") {
	let current = START;
	const secretReads: number[] = [];
	const assumeRoleInputs: Array<ConstructorParameters<typeof AssumeRoleCommand>[0]> = [];
	const logLines: string[] = [];
	const handler = createOwnerCredentialBrokerHandler({
		now: () => current,
		secrets: {
			send: async () => {
				secretReads.push(current.getTime());
				return { SecretString: SIGNING_KEY };
			},
		} as never,
		sts: {
			send: async (command: AssumeRoleCommand) => {
				assumeRoleInputs.push(command.input);
				return {
					Credentials: {
						AccessKeyId: "ASIA",
						SecretAccessKey: "secret-access-key",
						SessionToken: "session-token",
						Expiration: new Date(current.getTime() + 3600 * 1000),
					},
				};
			},
		} as never,
		supervisorRoleArn: "arn:aws:iam::111111111111:role/ComputerSupervisorRole",
		scopedRoleArn: "arn:aws:iam::111111111111:role/ComputerOwnerScopedRole",
		signingKeySecretArn: "arn:aws:secretsmanager:us-east-1:111111111111:secret:key",
		emit: (event, fields = {}) => logLines.push(`${event} ${JSON.stringify(fields)}`),
	});
	const request = (): OwnerCredentialBrokerRequest => ({
		version: 1,
		purpose: "supervisor",
		tenant_id: "anthus",
		computer_id: "computer-1",
		owner_id: ownerId,
		generation: 1,
		authorization: mintOwnerBootstrapToken(SIGNING_KEY, {
			audience: "owner-bootstrap",
			tenantId: "anthus",
			computerId: "computer-1",
			ownerId,
			startGeneration: 1,
			issuedAtSeconds: Math.floor(current.getTime() / 1000),
			expiresAtSeconds: Math.floor(current.getTime() / 1000) + 300,
		}),
	});
	return {
		handler,
		request,
		secretReads,
		assumeRoleInputs,
		logLines,
		advanceSeconds: (seconds: number) => {
			current = new Date(current.getTime() + seconds * 1000);
		},
	};
}

describe("owner credential broker internals", () => {
	it("reads the signing key once inside its cache window and again after it", async () => {
		const { handler, request, secretReads, advanceSeconds } = harness();
		await handler(request());
		advanceSeconds(BROKER_SIGNING_KEY_CACHE_SECONDS - 1);
		await handler(request());
		expect(secretReads).toHaveLength(1);
		advanceSeconds(2);
		await handler(request());
		expect(secretReads).toHaveLength(2);
	});

	it("names the role session after the purpose and owner, cut to 64 characters with only characters STS accepts", async () => {
		const { handler, request, assumeRoleInputs } = harness(`owner-${"x".repeat(80)}`);
		await handler(request());
		const name = assumeRoleInputs[0]!.RoleSessionName!;
		expect(name.length).toBe(64);
		expect(name.startsWith("supervisor-owner-xxx")).toBe(true);
		const colon = harness("owner:with/odd chars");
		await colon.handler(colon.request());
		expect(colon.assumeRoleInputs[0]!.RoleSessionName).toBe("supervisor-owner-with-odd-chars");
	});

	it("writes log lines that carry no token, key or credential", async () => {
		const { handler, request, logLines } = harness();
		const answer = await handler(request());
		expect(answer.ok).toBe(true);
		const text = logLines.join("\n");
		for (const secret of [SIGNING_KEY, "secret-access-key", "session-token", "ct1."]) {
			expect(text.includes(secret)).toBe(false);
		}
		expect(text).toContain("owner_broker_issued");
	});
});
