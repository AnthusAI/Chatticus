import {
	OwnerCredentialBrokerError,
	type OwnerCredentialBrokerFailureCode,
	type OwnerCredentialBrokerPort,
	type SupervisorGrant,
	type SupervisorGrantRequest,
	type SupervisorRenewalGrant,
	type SupervisorRenewalGrantRequest,
	type TurnGrant,
	type TurnGrantRequest,
} from "../../src/computer/owner-credential-broker.ts";
import { OwnerSessionTagError, ownerSessionTags, supervisorSessionTags, type SessionTag } from "../../src/gateway/session-tags.ts";
import { mintComputerOwnerToken, mintSessionToken, verifyComputerOwnerToken, verifyOwnerBootstrapToken } from "../../src/gateway/session-token.ts";
import {
	OWNER_BROKER_MINIMUM_SESSION_SECONDS,
	OWNER_CREDENTIAL_LIFETIME_SECONDS,
	OWNER_HARD_LIFETIME_SECONDS,
} from "@chatticus/host-protocol/supervisor";
import type { Clock } from "../clock.ts";

/** One request the fake broker served or refused, with the session tags the real broker would have assumed the role with. */
export type RecordedBrokerCall = {
	readonly request: SupervisorGrantRequest | SupervisorRenewalGrantRequest | TurnGrantRequest;
	readonly tags: readonly SessionTag[];
};

/**
 * The credential broker, faked for scenarios. It does what the real Lambda does short of calling STS: it verifies the
 * authorization with the scenario's signing key (audience, signature, expiry, and claims equal to the payload), builds the
 * real session tags with {@link supervisorSessionTags} or {@link ownerSessionTags}, mints the real supervisor or gateway
 * token with the real mint functions, and answers fixed credentials that expire when the tokens do. The owner's start is
 * the bootstrap's own time for `supervisor` and the token's signed claim for `supervisor_renewal` and `turn`; no
 * credential outlives the start plus the hard lifetime, and nothing is issued in the last minimum-session seconds of it
 * (`owner_lifetime_over`). It records every call, can be made to fail the next call with any broker error code, and can hold
 * the next call's answer until a step releases it.
 */
export class FakeOwnerCredentialBroker implements OwnerCredentialBrokerPort {
	readonly calls: RecordedBrokerCall[] = [];
	private readonly signingKey: string;
	private readonly clock: Clock;
	private pendingFailure: OwnerCredentialBrokerFailureCode | null = null;
	private pendingHold: Promise<void> | null = null;

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

	/**
	 * Make the next call, and only the next, wait before it answers. The answer, or the failure, is produced, and the call
	 * recorded, only after the returned function is called. The clock is read when the call arrives, not when it is released.
	 *
	 * @returns The function that releases the held call.
	 */
	holdNextCall(): () => void {
		let release: () => void = () => undefined;
		this.pendingHold = new Promise<void>((resolve) => {
			release = resolve;
		});
		return release;
	}

	issue(request: SupervisorGrantRequest): Promise<SupervisorGrant>;
	issue(request: SupervisorRenewalGrantRequest): Promise<SupervisorRenewalGrant>;
	issue(request: TurnGrantRequest): Promise<TurnGrant>;
	async issue(
		request: SupervisorGrantRequest | SupervisorRenewalGrantRequest | TurnGrantRequest,
	): Promise<SupervisorGrant | SupervisorRenewalGrant | TurnGrant> {
		const hold = this.pendingHold;
		this.pendingHold = null;
		const failure = this.pendingFailure;
		this.pendingFailure = null;
		const now = this.clock.now();
		const nowSeconds = Math.floor(now.getTime() / 1000);
		if (hold !== null) await hold;
		if (failure !== null) {
			this.calls.push({ request, tags: [] });
			throw new OwnerCredentialBrokerError(failure, `The fake broker was told to fail with ${failure}.`);
		}
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
		const ownerStartedAtSeconds = "ownerStartedAtSeconds" in claims ? claims.ownerStartedAtSeconds : nowSeconds;
		const hardEndSeconds = ownerStartedAtSeconds + OWNER_HARD_LIFETIME_SECONDS;
		if (hardEndSeconds - nowSeconds < OWNER_BROKER_MINIMUM_SESSION_SECONDS) {
			this.calls.push({ request, tags: [] });
			throw new OwnerCredentialBrokerError("owner_lifetime_over", "The owner is within its minimum session of its hard end, or past it.");
		}
		let tags: SessionTag[];
		try {
			tags =
				request.purpose === "turn"
					? ownerSessionTags({
							tenantId: request.tenant_id,
							botId: request.turn.bot_id,
							channelId: request.turn.channel_id,
							computerId: request.computer_id,
							turnId: request.turn.turn_id,
						})
					: supervisorSessionTags({ tenantId: request.tenant_id, computerId: request.computer_id });
		} catch (error) {
			if (!(error instanceof OwnerSessionTagError)) throw error;
			this.calls.push({ request, tags: [] });
			throw new OwnerCredentialBrokerError("unsafe_tag_value", error.message);
		}
		this.calls.push({ request, tags });
		const expiresAtSeconds = nowSeconds + Math.min(OWNER_CREDENTIAL_LIFETIME_SECONDS, hardEndSeconds - nowSeconds);
		const expiresAt = new Date(expiresAtSeconds * 1000).toISOString();
		const awsCredentials = {
			access_key_id: `ASIAFAKE${request.purpose.toUpperCase()}`,
			secret_access_key: `fake-secret-${request.owner_id}`,
			session_token: `fake-session-${request.purpose}-${request.owner_id}-${String(nowSeconds)}`,
			expires_at: expiresAt,
		};
		if (request.purpose === "turn") {
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
		const supervisorToken = mintComputerOwnerToken(this.signingKey, {
			audience: "computer-owner",
			tenantId: request.tenant_id,
			computerId: request.computer_id,
			ownerId: request.owner_id,
			startGeneration: request.generation,
			ownerStartedAtSeconds,
			issuedAtSeconds: nowSeconds,
			expiresAtSeconds,
		});
		if (request.purpose === "supervisor_renewal") {
			return {
				ok: true,
				purpose: "supervisor_renewal",
				aws_credentials: awsCredentials,
				supervisor_token: supervisorToken,
				supervisor_token_expires_at: expiresAt,
			};
		}
		return {
			ok: true,
			purpose: "supervisor",
			aws_credentials: awsCredentials,
			supervisor_token: supervisorToken,
			supervisor_token_expires_at: expiresAt,
		};
	}
}
