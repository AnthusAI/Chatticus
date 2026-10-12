import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import {
	OWNER_CREDENTIAL_LIFETIME_SECONDS,
	ownerCredentialBrokerRequestSchema,
	type OwnerCredentialBrokerErrorCode,
	type OwnerCredentialBrokerRequest,
	type OwnerCredentialBrokerResponse,
} from "@chatticus/host-protocol/supervisor";
import { consoleLogEmitter, errorNameOf, type LogEmitter } from "../observability/log-line.ts";
import { OwnerSessionTagError, ownerSessionTags, supervisorSessionTags, type SessionTag } from "../gateway/session-tags.ts";
import { mintComputerOwnerToken, mintSessionToken, verifyComputerOwnerToken, verifyOwnerBootstrapToken } from "../gateway/session-token.ts";

/** Seconds the broker keeps the signing key it read from Secrets Manager before it reads it again. */
export const BROKER_SIGNING_KEY_CACHE_SECONDS = 300;

const ROLE_SESSION_NAME_MAXIMUM_CHARACTERS = 64;
const ROLE_SESSION_NAME_DISALLOWED = /[^\w+=,.@-]/g;

/** Everything the broker needs, injected so scenarios run it without AWS. */
export type OwnerCredentialBrokerDependencies = {
	readonly sts: Pick<STSClient, "send">;
	readonly secrets: Pick<SecretsManagerClient, "send">;
	readonly now: () => Date;
	/** The role assumed for `purpose: supervisor`. Fixed by the deployment; no request chooses it. */
	readonly supervisorRoleArn: string;
	/** The role assumed for `purpose: turn`. Fixed by the deployment; no request chooses it. */
	readonly scopedRoleArn: string;
	/** The secret that holds the key tokens are signed with. */
	readonly signingKeySecretArn: string;
	readonly emit?: LogEmitter;
};

/** The broker as Lambda invokes it: the payload in, the answer out. It never throws for a refusal. */
export type OwnerCredentialBrokerHandler = (event: unknown) => Promise<OwnerCredentialBrokerResponse>;

function refusal(code: OwnerCredentialBrokerErrorCode, message: string): OwnerCredentialBrokerResponse {
	return { ok: false, error: { code, message } };
}

function roleSessionNameFor(request: OwnerCredentialBrokerRequest): string {
	return `${request.purpose}-${request.owner_id}`.replace(ROLE_SESSION_NAME_DISALLOWED, "-").slice(0, ROLE_SESSION_NAME_MAXIMUM_CHARACTERS);
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
	if (request.purpose === "supervisor") {
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
 * credentials. It reads no store, so the Front Door alone decides whether a turn is really parked (docs/OWNER_SUPERVISOR_PROTOCOL.md section 7).
 *
 * @param dependencies The STS and Secrets Manager clients, the clock and the fixed role and secret ARNs.
 * @returns The Lambda handler.
 */
export function createOwnerCredentialBrokerHandler(dependencies: OwnerCredentialBrokerDependencies): OwnerCredentialBrokerHandler {
	const emit = dependencies.emit ?? consoleLogEmitter();
	let cachedSigningKey: { readonly value: string; readonly readAtMilliseconds: number } | null = null;

	async function signingKey(): Promise<string | null> {
		const nowMilliseconds = dependencies.now().getTime();
		if (cachedSigningKey !== null && nowMilliseconds - cachedSigningKey.readAtMilliseconds < BROKER_SIGNING_KEY_CACHE_SECONDS * 1000) {
			return cachedSigningKey.value;
		}
		try {
			const response = await dependencies.secrets.send(new GetSecretValueCommand({ SecretId: dependencies.signingKeySecretArn }));
			const value = response.SecretString ?? "";
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

		let tags: SessionTag[];
		try {
			tags = tagsFor(request);
		} catch (error) {
			if (!(error instanceof OwnerSessionTagError)) throw error;
			return refuse("unsafe_tag_value", "An identifier cannot be a session tag value.");
		}

		let credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: Date };
		try {
			const assumed = await dependencies.sts.send(
				new AssumeRoleCommand({
					RoleArn: request.purpose === "supervisor" ? dependencies.supervisorRoleArn : dependencies.scopedRoleArn,
					RoleSessionName: roleSessionNameFor(request),
					DurationSeconds: OWNER_CREDENTIAL_LIFETIME_SECONDS,
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
		const nowSeconds = Math.floor(now.getTime() / 1000);
		const expiresAtSeconds = Math.min(nowSeconds + OWNER_CREDENTIAL_LIFETIME_SECONDS, Math.floor(credentials.expiration.getTime() / 1000));
		const awsCredentials = {
			access_key_id: credentials.accessKeyId,
			secret_access_key: credentials.secretAccessKey,
			session_token: credentials.sessionToken,
			expires_at: expiresAt,
		};
		emit("owner_broker_issued", scope);
		if (request.purpose === "supervisor") {
			return {
				ok: true,
				purpose: "supervisor",
				aws_credentials: awsCredentials,
				supervisor_token: mintComputerOwnerToken(key, {
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

function requiredEnvironment(name: string): string {
	const value = process.env[name] ?? "";
	if (value === "") throw new Error(`The environment variable ${name} is required.`);
	return value;
}

let deployedHandler: OwnerCredentialBrokerHandler | null = null;

/** The deployed entry point: composes the broker from its environment on the first invocation. */
export const handler: OwnerCredentialBrokerHandler = async (event) => {
	if (deployedHandler === null) {
		deployedHandler = createOwnerCredentialBrokerHandler({
			sts: new STSClient({}),
			secrets: new SecretsManagerClient({}),
			now: () => new Date(),
			supervisorRoleArn: requiredEnvironment("CHATTICUS_OWNER_SUPERVISOR_ROLE_ARN"),
			scopedRoleArn: requiredEnvironment("CHATTICUS_OWNER_SCOPED_ROLE_ARN"),
			signingKeySecretArn: requiredEnvironment("CHATTICUS_MODEL_GATEWAY_SIGNING_KEY_SECRET_ARN"),
		});
	}
	return deployedHandler(event);
};
