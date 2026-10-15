/**
 * The Front Door's port to the OwnerCredentialBroker, the only principal that assumes the two owner roles and signs the
 * supervisor and per-turn gateway tokens (docs/OWNER_SUPERVISOR_PROTOCOL.md section 7).
 *
 * This file holds only types and one error class, with type-only imports, so a bundle that includes it pulls in no SDK
 * client. The Lambda adapter lives in `lambda-owner-credential-broker.ts`, which only the Front Door imports; the owner and
 * supervisor bundles must never import it (`computer-image-structure.test.ts` guards that).
 */

import type { OwnerCredentialBrokerErrorCode, OwnerCredentialBrokerRequest, OwnerCredentialBrokerResponse } from "@chatticus/host-protocol/supervisor";

/** The grant the broker issues for `purpose: supervisor`: the supervisor role's credentials and the supervisor token. */
export type SupervisorGrant = Extract<OwnerCredentialBrokerResponse, { ok: true; purpose: "supervisor" }>;

/** The grant the broker issues for `purpose: supervisor_renewal`: the next set of the supervisor role's credentials and a new supervisor token of the same owner. */
export type SupervisorRenewalGrant = Extract<OwnerCredentialBrokerResponse, { ok: true; purpose: "supervisor_renewal" }>;

/** The grant the broker issues for `purpose: turn`: the per-turn role's credentials and the model gateway token. */
export type TurnGrant = Extract<OwnerCredentialBrokerResponse, { ok: true; purpose: "turn" }>;

/** The request of a supervisor grant: authorized by the bootstrap token. */
export type SupervisorGrantRequest = Extract<OwnerCredentialBrokerRequest, { purpose: "supervisor" }>;

/** The request of a supervisor renewal: authorized by the supervisor token, which must still be valid. */
export type SupervisorRenewalGrantRequest = Extract<OwnerCredentialBrokerRequest, { purpose: "supervisor_renewal" }>;

/** The request of a turn grant: authorized by the supervisor token and naming the turn. */
export type TurnGrantRequest = Extract<OwnerCredentialBrokerRequest, { purpose: "turn" }>;

/** Why the Front Door received no grant: a code the broker answered, or a failure to reach or understand it. */
export type OwnerCredentialBrokerFailureCode = OwnerCredentialBrokerErrorCode | "broker_unreachable" | "malformed_response";

/**
 * The broker issued nothing. The message never carries a token, a key or a credential.
 */
export class OwnerCredentialBrokerError extends Error {
	readonly code: OwnerCredentialBrokerFailureCode;

	/**
	 * @param code What went wrong.
	 * @param message A description free of tokens, keys and credentials.
	 */
	constructor(code: OwnerCredentialBrokerFailureCode, message: string) {
		super(message);
		this.name = "OwnerCredentialBrokerError";
		this.code = code;
	}
}

/**
 * What the Front Door asks of the broker. `issue` throws {@link OwnerCredentialBrokerError} for `ok: false`, an unreachable
 * broker and a response that does not parse.
 */
export interface OwnerCredentialBrokerPort {
	issue(request: SupervisorGrantRequest): Promise<SupervisorGrant>;
	issue(request: SupervisorRenewalGrantRequest): Promise<SupervisorRenewalGrant>;
	issue(request: TurnGrantRequest): Promise<TurnGrant>;
}
