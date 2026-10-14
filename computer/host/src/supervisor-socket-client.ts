import { connect } from "node:net";
import { ownerSocketResponseSchema } from "@chatticus/host-protocol/supervisor";
import type { z } from "zod";
import { requiredSetting } from "./owner-configuration.ts";
import type { StorageCredentialsProvider } from "./supervisor-ports.ts";

/** The most bytes of an answer the child reads. A set of credentials with its token is a few kilobytes; anything near this is not an answer. */
export const OWNER_SOCKET_MAXIMUM_ANSWER_BYTES = 16 * 1024;

/** How long the child waits for the supervisor's answer, in milliseconds. */
export const OWNER_SOCKET_ANSWER_TIMEOUT_MILLISECONDS = 5000;

/** What the supervisor's socket handed the child: the credentials of its turn. */
export type OwnerSocketGrant = Extract<z.infer<typeof ownerSocketResponseSchema>, { readonly ok: true }>;

/** Why the child holds no credentials right now. `unreachable` and `unreadable_answer` are the child's own; the others are the supervisor's. */
export type SupervisorCredentialsFailure = "no_turn" | "expired" | "unreachable" | "unreadable_answer";

/**
 * The child has no credentials for its turn: the supervisor said so, or could not be asked, or answered with something that
 * is not an answer. The child never falls back to anything else, so a request that needed the credentials fails with this
 * and the turn ends as an error. The message names the reason and carries no value.
 */
export class SupervisorCredentialsUnavailableError extends Error {
	readonly reason: SupervisorCredentialsFailure;

	constructor(reason: SupervisorCredentialsFailure) {
		super(`the supervisor holds no usable credentials for this turn: ${reason}`);
		this.name = "SupervisorCredentialsUnavailableError";
		this.reason = reason;
	}
}

/** Where to ask and which dispatch to ask for. */
export type SupervisorSocketClientOptions = {
	readonly socketPath: string;
	readonly dispatchId: string;
	readonly answerTimeoutMilliseconds?: number;
};

/** Asks the supervisor's socket for the credentials of this child's dispatch, one connection for each question. */
export class SupervisorSocketClient {
	private readonly socketPath: string;
	private readonly dispatchId: string;
	private readonly answerTimeoutMilliseconds: number;

	constructor(options: SupervisorSocketClientOptions) {
		this.socketPath = options.socketPath;
		this.dispatchId = options.dispatchId;
		this.answerTimeoutMilliseconds = options.answerTimeoutMilliseconds ?? OWNER_SOCKET_ANSWER_TIMEOUT_MILLISECONDS;
	}

	/**
	 * Read the credentials the supervisor holds for this dispatch right now.
	 *
	 * @returns The AWS credentials, the model gateway token and when they end.
	 * @throws SupervisorCredentialsUnavailableError If the supervisor has none for this dispatch, they are past their end, the socket cannot be reached or the answer cannot be read.
	 */
	async turnCredentials(): Promise<OwnerSocketGrant> {
		const line = await this.exchange();
		let parsed: ReturnType<typeof ownerSocketResponseSchema.safeParse>;
		try {
			parsed = ownerSocketResponseSchema.safeParse(JSON.parse(line));
		} catch {
			throw new SupervisorCredentialsUnavailableError("unreadable_answer");
		}
		if (!parsed.success) throw new SupervisorCredentialsUnavailableError("unreadable_answer");
		if (!parsed.data.ok) throw new SupervisorCredentialsUnavailableError(parsed.data.code);
		return parsed.data;
	}

	private exchange(): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			const connection = connect(this.socketPath);
			let received = Buffer.alloc(0);
			let settled = false;
			const settle = (outcome: { readonly line: string } | { readonly failure: SupervisorCredentialsFailure }): void => {
				if (settled) return;
				settled = true;
				connection.destroy();
				if ("line" in outcome) resolve(outcome.line);
				else reject(new SupervisorCredentialsUnavailableError(outcome.failure));
			};
			connection.setTimeout(this.answerTimeoutMilliseconds, () => settle({ failure: "unreachable" }));
			connection.on("error", () => settle({ failure: "unreachable" }));
			connection.on("connect", () => connection.write(`${JSON.stringify({ v: 1, op: "turn_credentials", dispatch_id: this.dispatchId })}\n`));
			connection.on("data", (chunk) => {
				received = Buffer.concat([received, chunk]);
				const newline = received.indexOf(0x0a);
				if (newline !== -1) settle({ line: received.subarray(0, newline).toString("utf8") });
				else if (received.length > OWNER_SOCKET_MAXIMUM_ANSWER_BYTES) settle({ failure: "unreadable_answer" });
			});
			connection.on("end", () => settle({ failure: "unreachable" }));
			connection.on("close", () => settle({ failure: "unreachable" }));
		});
	}
}

/** The two things a child asks its supervisor for, each as a function the SDK or the model request calls when it needs a value. */
export type TurnCredentialProviders = {
	/** The AWS credentials of the turn, with their real expiration, so the SDK asks again before they end and receives whatever the supervisor holds then. */
	readonly awsCredentials: StorageCredentialsProvider;
	/** The model gateway token the supervisor holds right now; the model request asks for it each time it sends one. */
	readonly gatewayToken: () => Promise<string>;
};

/**
 * Providers that read the child's credentials from the supervisor each time they are asked and keep nothing between calls.
 *
 * @param client The socket client of this child's dispatch.
 * @returns A provider for the AWS clients and one for the model gateway token.
 */
export function turnCredentialProviders(client: SupervisorSocketClient): TurnCredentialProviders {
	return {
		awsCredentials: async () => {
			const grant = await client.turnCredentials();
			return {
				accessKeyId: grant.aws_credentials.access_key_id,
				secretAccessKey: grant.aws_credentials.secret_access_key,
				sessionToken: grant.aws_credentials.session_token,
				expiration: new Date(grant.aws_credentials.expires_at),
			};
		},
		gatewayToken: async () => (await client.turnCredentials()).gateway_token,
	};
}

/**
 * Build the socket client of this child from the environment its supervisor made: the socket's path and the dispatch it serves.
 *
 * @param environment The process environment.
 * @returns The client.
 * @throws OwnerConfigurationError If either name is missing.
 */
export function supervisorSocketClientFromEnvironment(environment: NodeJS.ProcessEnv = process.env): SupervisorSocketClient {
	return new SupervisorSocketClient({
		socketPath: requiredSetting(environment, "CHATTICUS_SUPERVISOR_SOCKET"),
		dispatchId: requiredSetting(environment, "CHATTICUS_DISPATCH_ID"),
	});
}
