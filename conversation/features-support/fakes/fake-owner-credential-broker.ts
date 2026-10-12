import {
	OwnerCredentialBrokerError,
	type OwnerCredentialBrokerFailureCode,
	type OwnerCredentialBrokerPort,
	type SupervisorGrant,
	type SupervisorGrantRequest,
	type TurnGrant,
	type TurnGrantRequest,
} from "../../src/computer/owner-credential-broker.ts";
import { OwnerSessionTagError, ownerSessionTags, supervisorSessionTags, type SessionTag } from "../../src/gateway/session-tags.ts";
import { mintComputerOwnerToken, mintSessionToken, verifyComputerOwnerToken, verifyOwnerBootstrapToken } from "../../src/gateway/session-token.ts";
import { OWNER_CREDENTIAL_LIFETIME_SECONDS } from "@chatticus/host-protocol/supervisor";
import type { Clock } from "../clock.ts";

/** One request the fake broker served or refused, with the session tags the real broker would have assumed the role with. */
export type RecordedBrokerCall = {
	readonly request: SupervisorGrantRequest | TurnGrantRequest;
	readonly tags: readonly SessionTag[];
};

/**
 * The credential broker, faked for scenarios. It does what the real Lambda does short of calling STS: it verifies the
 * authorization with the scenario's signing key (audience, signature, expiry, and claims equal to the payload), builds the
 * real session tags with {@link supervisorSessionTags} or {@link ownerSessionTags}, mints the real supervisor or gateway
 * token with the real mint functions, and answers fixed credentials that expire when the tokens do. It records every call
 * and can be made to fail the next call with any broker error code.
 */
export class FakeOwnerCredentialBroker implements OwnerCredentialBrokerPort {
	readonly calls: RecordedBrokerCall[] = [];
	private readonly signingKey: string;
	private readonly clock: Clock;
	private pendingFailure: OwnerCredentialBrokerFailureCode | null = null;

	/**
	 * @param signingKey The scenario's token signing key.
	 * @param clock The scenario's clock, which decides expiry.
	 */
	constructor(signingKey: string, clock: Clock) {
		this.signingKey = signingKey;
		this.clock = clock;
	}

	/** Make the next call, and only the next, throw {@link OwnerCredentialBrokerError} with this code. */
	failNextCall(code: OwnerCredentialBrokerFailureCode): void {
		this.pendingFailure = code;
	}

	issue(request: SupervisorGrantRequest): Promise<SupervisorGrant>;
	issue(request: TurnGrantRequest): Promise<TurnGrant>;
	async issue(request: SupervisorGrantRequest | TurnGrantRequest): Promise<SupervisorGrant | TurnGrant> {
		const failure = this.pendingFailure;
		if (failure !== null) {
			this.pendingFailure = null;
			this.calls.push({ request, tags: [] });
			throw new OwnerCredentialBrokerError(failure, `The fake broker was told to fail with ${failure}.`);
		}
		const now = this.clock.now();
		const nowSeconds = Math.floor(now.getTime() / 1000);
		const verification =
			request.purpose === "supervisor"
				? verifyOwnerBootstrapToken(this.signingKey, request.authorization, now)
				: verifyComputerOwnerToken(this.signingKey, request.authorization, now);
		if (!verification.valid) {
			this.calls.push({ request, tags: [] });
			throw new OwnerCredentialBrokerError("invalid_authorization", `The authorization was refused (${verification.reason}).`);
		}
		const claims = verification.claims;
		if (
			claims.tenantId !== request.tenant_id ||
			claims.computerId !== request.computer_id ||
			claims.ownerId !== request.owner_id ||
			claims.startGeneration !== request.generation
		) {
			this.calls.push({ request, tags: [] });
			throw new OwnerCredentialBrokerError("authorization_mismatch", "The authorization names another owner than the payload.");
		}
		let tags: SessionTag[];
		try {
			tags =
				request.purpose === "supervisor"
					? supervisorSessionTags({ tenantId: request.tenant_id, computerId: request.computer_id })
					: ownerSessionTags({
							tenantId: request.tenant_id,
							botId: request.turn.bot_id,
							channelId: request.turn.channel_id,
							computerId: request.computer_id,
							turnId: request.turn.turn_id,
						});
		} catch (error) {
			if (!(error instanceof OwnerSessionTagError)) throw error;
			this.calls.push({ request, tags: [] });
			throw new OwnerCredentialBrokerError("unsafe_tag_value", error.message);
		}
		this.calls.push({ request, tags });
		const expiresAtSeconds = nowSeconds + OWNER_CREDENTIAL_LIFETIME_SECONDS;
		const expiresAt = new Date(expiresAtSeconds * 1000).toISOString();
		const awsCredentials = {
			access_key_id: `ASIAFAKE${request.purpose.toUpperCase()}`,
			secret_access_key: `fake-secret-${request.owner_id}`,
			session_token: `fake-session-${request.purpose}-${request.owner_id}-${String(nowSeconds)}`,
			expires_at: expiresAt,
		};
		if (request.purpose === "supervisor") {
			return {
				ok: true,
				purpose: "supervisor",
				aws_credentials: awsCredentials,
				supervisor_token: mintComputerOwnerToken(this.signingKey, {
					audience: "computer-owner",
					tenantId: request.tenant_id,
					computerId: request.computer_id,
					ownerId: request.owner_id,
					startGeneration: request.generation,
					issuedAtSeconds: nowSeconds,
					expiresAtSeconds,
				}),
				supervisor_token_expires_at: expiresAt,
			};
		}
		return {
			ok: true,
			purpose: "turn",
			aws_credentials: awsCredentials,
			gateway_token: mintSessionToken(this.signingKey, {
				audience: "model-gateway",
				tenantId: request.tenant_id,
				botId: request.turn.bot_id,
				turnId: request.turn.turn_id,
				ownerId: request.owner_id,
				startGeneration: request.generation,
				expiresAtSeconds,
			}),
			expires_at: expiresAt,
		};
	}
}
