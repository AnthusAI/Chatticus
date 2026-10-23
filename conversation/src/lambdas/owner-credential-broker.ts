import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import {
	OWNER_BROKER_MINIMUM_SESSION_SECONDS,
	OWNER_CREDENTIAL_LIFETIME_SECONDS,
	OWNER_HARD_LIFETIME_SECONDS,
	ownerCredentialBrokerRequestSchema,
	type OwnerCredentialBrokerErrorCode,
	type OwnerCredentialBrokerRequest,
	type OwnerCredentialBrokerResponse,
} from "@chatticus/host-protocol/supervisor";
import { consoleLogEmitter, errorNameOf, type LogEmitter } from "../observability/log-line.ts";
import { OwnerSessionTagError, ownerSessionTags, supervisorSessionTags, type SessionTag } from "../gateway/session-tags.ts";
import { NO_OWNER_BROKER_FAULTS, ownerBrokerFaultsFromEnvironment, type OwnerBrokerFaults } from "./owner-credential-broker-faults.ts";
import { mintComputerOwnerToken, mintSessionToken, verifyComputerOwnerToken, verifyOwnerBootstrapToken } from "../gateway/session-token.ts";

/** Seconds the broker keeps the signing key it read from SSM before it reads it again. */
export const BROKER_SIGNING_KEY_CACHE_SECONDS = 300;

const ROLE_SESSION_NAME_MAXIMUM_CHARACTERS = 64;
const ROLE_SESSION_NAME_DISALLOWED = /[^\w+=,.@-]/g;

/** Everything the broker needs, injected so scenarios run it without AWS. */
export type OwnerCredentialBrokerDependencies = {
	readonly sts: Pick<STSClient, "send">;
	readonly parameters: Pick<SSMClient, "send">;
	readonly now: () => Date;
	/** The role assumed for `purpose: supervisor` and `purpose: supervisor_renewal`. Fixed by the deployment; no request chooses it. */
	readonly supervisorRoleArn: string;
	/** The role assumed for `purpose: turn`. Fixed by the deployment; no request chooses it. */
	readonly scopedRoleArn: string;
	/** The SSM SecureString parameter that holds the key tokens are signed with. */
	readonly signingKeyParameterName: string;
	readonly emit?: LogEmitter;
	/** The development fault switch. Defaults to none; only the deployed entry point sets it, from the environment. */
	readonly faults?: OwnerBrokerFaults;
};

/** The broker as Lambda invokes it: the payload in, the answer out. It never throws for a refusal. */
export type OwnerCredentialBrokerHandler = (event: unknown) => Promise<OwnerCredentialBrokerResponse>;

function refusal(code: OwnerCredentialBrokerErrorCode, message: string): OwnerCredentialBrokerResponse {
	return { ok: false, error: { code, message } };
}

function roleSessionNameFor(request: OwnerCredentialBrokerRequest): string {
	const prefix = request.purpose === "turn" ? "turn" : "supervisor";
	return `${prefix}-${request.owner_id}`.replace(ROLE_SESSION_NAME_DISALLOWED, "-").slice(0, ROLE_SESSION_NAME_MAXIMUM_CHARACTERS);
}

function authorizationMatches(
	claims: { tenantId: string; computerId: string; ownerId: string; startGeneration: number },
	request: OwnerCredentialBrokerRequest,
): boolean {
	return (
		claims.tenantId === request.tenant_id &&
		claims.computerId === request.computer_id &&
		claims.ownerId === request.owner_id &&
		claims.startGeneration === request.generation
	);
}

function tagsFor(request: OwnerCredentialBrokerRequest): SessionTag[] {
	if (request.purpose !== "turn") {
		return supervisorSessionTags({ tenantId: request.tenant_id, computerId: request.computer_id });
	}
	return ownerSessionTags({
		tenantId: request.tenant_id,
		botId: request.turn.bot_id,
		channelId: request.turn.channel_id,
		computerId: request.computer_id,
		turnId: request.turn.turn_id,
	});
}

/**
 * Build the OwnerCredentialBroker: the only principal that assumes the supervisor and per-turn roles and the only one
 * besides the Front Door and the starter that holds the signing key. It verifies the authorization itself, assumes a fixed
 * role with tags derived from the verified payload and no session policy, and signs a token that expires with the
 * credentials. No credential or token it issues ends after the owner's hard lifetime, counted from the signed
 * `ownerStartedAtSeconds` claim, and nothing is issued in the last minimum session of it. It reads no store, so the Front Door alone decides whether a turn is really parked (docs/OWNER_SUPERVISOR_PROTOCOL.md section 7).
 *
 * @param dependencies The STS and SSM clients, the clock and the fixed role ARNs and parameter name.
 * @returns The Lambda handler.
 */
export function createOwnerCredentialBrokerHandler(dependencies: OwnerCredentialBrokerDependencies): OwnerCredentialBrokerHandler {
	const emit = dependencies.emit ?? consoleLogEmitter();
	const faults = dependencies.faults ?? NO_OWNER_BROKER_FAULTS;
	let cachedSigningKey: { readonly value: string; readonly readAtMilliseconds: number } | null = null;

	async function signingKey(): Promise<string | null> {
		const nowMilliseconds = dependencies.now().getTime();
		if (cachedSigningKey !== null && nowMilliseconds - cachedSigningKey.readAtMilliseconds < BROKER_SIGNING_KEY_CACHE_SECONDS * 1000) {
			return cachedSigningKey.value;
		}
		try {
			const response = await dependencies.parameters.send(new GetParameterCommand({ Name: dependencies.signingKeyParameterName, WithDecryption: true }));
			const value = response.Parameter?.Value ?? "";
			if (value === "") return null;
			cachedSigningKey = { value, readAtMilliseconds: nowMilliseconds };
			return value;
		} catch {
			return null;
		}
	}

	return async (event) => {
		const parsed = ownerCredentialBrokerRequestSchema.safeParse(event);
		if (!parsed.success) {
			emit("owner_broker_refused", { code: "invalid_request" });
			return refusal("invalid_request", "The request does not match the broker request schema.");
		}
		const request = parsed.data;
		const scope = {
			purpose: request.purpose,
			tenant_id: request.tenant_id,
			owner_id: request.owner_id,
			turn_id: request.purpose === "turn" ? request.turn.turn_id : undefined,
		};
		const refuse = (code: OwnerCredentialBrokerErrorCode, message: string, extra: { error_name?: string } = {}): OwnerCredentialBrokerResponse => {
			emit("owner_broker_refused", { ...scope, code, ...extra });
			return refusal(code, message);
		};

		const key = await signingKey();
		if (key === null) return refuse("signing_key_unavailable", "The signing key could not be read.");

		const now = dependencies.now();
		const verification =
			request.purpose === "supervisor"
				? verifyOwnerBootstrapToken(key, request.authorization, now)
				: verifyComputerOwnerToken(key, request.authorization, now);
		if (!verification.valid) return refuse("invalid_authorization", `The authorization was refused (${verification.reason}).`);
		if (!authorizationMatches(verification.claims, request)) {
			return refuse("authorization_mismatch", "The authorization names another owner than the payload.");
		}

		const nowSeconds = Math.floor(now.getTime() / 1000);
		const ownerStartedAtSeconds = "ownerStartedAtSeconds" in verification.claims ? verification.claims.ownerStartedAtSeconds : nowSeconds;
		const secondsUntilHardEnd = ownerStartedAtSeconds + OWNER_HARD_LIFETIME_SECONDS - nowSeconds;
		if (secondsUntilHardEnd < OWNER_BROKER_MINIMUM_SESSION_SECONDS) {
			return refuse("owner_lifetime_over", "The owner is within the minimum session of its hard lifetime, or past it.");
		}
		const durationSeconds = Math.min(OWNER_CREDENTIAL_LIFETIME_SECONDS, secondsUntilHardEnd, faults.maximumCredentialSeconds ?? OWNER_CREDENTIAL_LIFETIME_SECONDS);

		let tags: SessionTag[];
		try {
			tags = tagsFor(request);
		} catch (error) {
			if (!(error instanceof OwnerSessionTagError)) throw error;
			return refuse("unsafe_tag_value", "An identifier cannot be a session tag value.");
		}

		if (faults.deniedPurposes.has(request.purpose)) {
			return refuse("assume_role_failed", "FaultSwitchDenied", { error_name: "FaultSwitchDenied" });
		}

		let credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: Date };
		try {
			const assumed = await dependencies.sts.send(
				new AssumeRoleCommand({
					RoleArn: request.purpose === "turn" ? dependencies.scopedRoleArn : dependencies.supervisorRoleArn,
					RoleSessionName: roleSessionNameFor(request),
					DurationSeconds: durationSeconds,
					Tags: tags,
				}),
			);
			const received = assumed.Credentials;
			if (received?.AccessKeyId === undefined || received.SecretAccessKey === undefined || received.SessionToken === undefined || received.Expiration === undefined) {
				return refuse("assume_role_failed", "IncompleteCredentials");
			}
			credentials = {
				accessKeyId: received.AccessKeyId,
				secretAccessKey: received.SecretAccessKey,
				sessionToken: received.SessionToken,
				expiration: received.Expiration,
			};
		} catch (error) {
			const name = errorNameOf(error);
			return refuse("assume_role_failed", name, { error_name: name });
		}

		const expiresAt = credentials.expiration.toISOString();
		const expiresAtSeconds = Math.min(nowSeconds + durationSeconds, Math.floor(credentials.expiration.getTime() / 1000));
		const awsCredentials = {
			access_key_id: credentials.accessKeyId,
			secret_access_key: credentials.secretAccessKey,
			session_token: credentials.sessionToken,
			expires_at: expiresAt,
		};
		emit("owner_broker_issued", { ...scope, duration_seconds: durationSeconds });
		if (request.purpose !== "turn") {
			return {
				ok: true,
				purpose: request.purpose,
				aws_credentials: awsCredentials,
				supervisor_token: mintComputerOwnerToken(key, {
					audience: "computer-owner",
					tenantId: request.tenant_id,
					computerId: request.computer_id,
					ownerId: request.owner_id,
					startGeneration: request.generation,
					ownerStartedAtSeconds,
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
			gateway_token: mintSessionToken(key, {
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
	};
}

function requiredEnvironment(environment: Readonly<Record<string, string | undefined>>, name: string): string {
	const value = environment[name] ?? "";
	if (value === "") throw new Error(`The environment variable ${name} is required.`);
	return value;
}

/** The clients and clock the deployed entry point uses; scenarios replace them to run it without AWS. */
export type DeployedOwnerCredentialBrokerClients = Pick<OwnerCredentialBrokerDependencies, "sts" | "parameters" | "now">;

/**
 * Build the entry point Lambda invokes. The broker is composed from the environment on the first invocation, including
 * the development fault switch. When composition throws (a missing variable, or a fault variable outside development)
 * the error propagates, and every later invocation composes again and fails again, so the function issues nothing.
 *
 * @param environment The process environment of the function.
 * @param clients The STS and SSM clients and the clock; the real ones by default.
 * @returns The Lambda handler.
 */
export function createDeployedOwnerCredentialBrokerHandler(
	environment: Readonly<Record<string, string | undefined>>,
	clients: DeployedOwnerCredentialBrokerClients = { sts: new STSClient({}), parameters: new SSMClient({}), now: () => new Date() },
): OwnerCredentialBrokerHandler {
	let composed: OwnerCredentialBrokerHandler | null = null;
	return async (event) => {
		if (composed === null) {
			composed = createOwnerCredentialBrokerHandler({
				...clients,
				supervisorRoleArn: requiredEnvironment(environment, "CHATTICUS_OWNER_SUPERVISOR_ROLE_ARN"),
				scopedRoleArn: requiredEnvironment(environment, "CHATTICUS_OWNER_SCOPED_ROLE_ARN"),
				signingKeyParameterName: requiredEnvironment(environment, "CHATTICUS_MODEL_GATEWAY_SIGNING_KEY_PARAMETER_NAME"),
				faults: ownerBrokerFaultsFromEnvironment(environment),
			});
		}
		return composed(event);
	};
}

/** The deployed entry point. */
export const handler: OwnerCredentialBrokerHandler = createDeployedOwnerCredentialBrokerHandler(process.env);
