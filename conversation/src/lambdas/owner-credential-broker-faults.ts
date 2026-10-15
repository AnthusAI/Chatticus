import type { OwnerCredentialBrokerRequest } from "@chatticus/host-protocol/supervisor";

type BrokerPurpose = OwnerCredentialBrokerRequest["purpose"];

/** What the development fault switch does to the broker. It can only make the broker issue less (Phase 2b, R22, gate G4). */
export type OwnerBrokerFaults = {
	/** Purposes the broker refuses with `assume_role_failed` before it asks STS for anything. */
	readonly deniedPurposes: ReadonlySet<BrokerPurpose>;
	/** A cap on the credential duration in seconds, between 900 and 3600, or null for no cap. It never lengthens a session. */
	readonly maximumCredentialSeconds: number | null;
};

/** The faults of every deployment but a development one that asked for them: none. */
export const NO_OWNER_BROKER_FAULTS: OwnerBrokerFaults = { deniedPurposes: new Set(), maximumCredentialSeconds: null };

/** The shortest credential duration STS grants and so the shortest the fault switch can set. */
export const OWNER_BROKER_FAULT_MINIMUM_CREDENTIAL_SECONDS = 900;

/** The longest credential duration the role allows and so the longest the fault switch can set. */
export const OWNER_BROKER_FAULT_MAXIMUM_CREDENTIAL_SECONDS = 3600;

const DEVELOPMENT_ENVIRONMENT = "development";

const PURPOSES_DENIED_BY_FAULT: Readonly<Record<string, readonly BrokerPurpose[]>> = {
	none: [],
	deny_supervisor_renewal: ["supervisor_renewal"],
	deny_turn_renewal: ["turn"],
};

/**
 * Read the development fault switch from the broker's environment. This is the only reader of
 * `CHATTICUS_OWNER_BROKER_FAULT` and `CHATTICUS_OWNER_BROKER_CREDENTIAL_SECONDS`, and the only reader of
 * `CHATTICUS_ENVIRONMENT` in the broker. It throws, so the function fails closed on every invocation, when either
 * variable is present and the environment is not exactly `development` (a missing or empty environment counts as not
 * development), and when a variable holds a value the switch does not define.
 *
 * @param environment The process environment of the function.
 * @returns The faults to apply; none when neither variable is present.
 */
export function ownerBrokerFaultsFromEnvironment(environment: Readonly<Record<string, string | undefined>>): OwnerBrokerFaults {
	const faultName = environment.CHATTICUS_OWNER_BROKER_FAULT;
	const secondsText = environment.CHATTICUS_OWNER_BROKER_CREDENTIAL_SECONDS;
	if (faultName === undefined && secondsText === undefined) return NO_OWNER_BROKER_FAULTS;
	if (environment.CHATTICUS_ENVIRONMENT !== DEVELOPMENT_ENVIRONMENT) {
		throw new Error("The owner credential broker fault switch is set outside the development environment; refusing to start.");
	}
	const deniedPurposes = faultName !== undefined && Object.hasOwn(PURPOSES_DENIED_BY_FAULT, faultName) ? PURPOSES_DENIED_BY_FAULT[faultName] : undefined;
	if (faultName !== undefined && deniedPurposes === undefined) {
		throw new Error("CHATTICUS_OWNER_BROKER_FAULT is not one of none, deny_supervisor_renewal or deny_turn_renewal.");
	}
	let maximumCredentialSeconds: number | null = null;
	if (secondsText !== undefined) {
		maximumCredentialSeconds = /^\d+$/.test(secondsText) ? Number(secondsText) : Number.NaN;
		if (
			!Number.isInteger(maximumCredentialSeconds) ||
			maximumCredentialSeconds < OWNER_BROKER_FAULT_MINIMUM_CREDENTIAL_SECONDS ||
			maximumCredentialSeconds > OWNER_BROKER_FAULT_MAXIMUM_CREDENTIAL_SECONDS
		) {
			throw new Error("CHATTICUS_OWNER_BROKER_CREDENTIAL_SECONDS is not a whole number from 900 to 3600.");
		}
	}
	return { deniedPurposes: new Set(deniedPurposes ?? []), maximumCredentialSeconds };
}
