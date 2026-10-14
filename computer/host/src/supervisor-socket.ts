import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, lstatSync, rmSync } from "node:fs";
import { ownerSocketRequestSchema, ownerSocketResponseSchema, OWNER_SUPERVISOR_SOCKET_PATH } from "@chatticus/host-protocol/supervisor";
import type { z } from "zod";
import type { LogEmitter } from "../../../conversation/src/observability/log-line.ts";
import type { TurnCredentialSource } from "./supervisor-ports.ts";

/** The most bytes of one request, the newline included. A longer request is answered `no_turn` and closed. */
export const OWNER_SOCKET_MAXIMUM_REQUEST_BYTES = 1024;

/** The most connections the socket serves at once; the system refuses any more. */
export const OWNER_SOCKET_MAXIMUM_CONNECTIONS = 4;

/** How long a connection may stay open before it has sent its one request, in milliseconds. */
export const OWNER_SOCKET_REQUEST_TIMEOUT_MILLISECONDS = 5000;

/** The permission bits the socket file has once it is bound: read and write for its owner, nothing for anyone else. */
export const OWNER_SOCKET_FILE_MODE = 0o600;

type SocketResponse = z.infer<typeof ownerSocketResponseSchema>;

type SocketOutcome = "ok" | "no_turn" | "expired" | "malformed";

/** What the supervisor's socket server is built from. */
export type SupervisorSocketServerOptions = {
	/** Where to listen: a filesystem path inside a directory only root can enter. Never an abstract name, never a TCP port. */
	readonly socketPath?: string;
	/** The credentials of the dispatch being served, which the supervisor renews and this server only reads. */
	readonly source: TurnCredentialSource;
	/** Whether a child is running now; while none is, a connection is closed without being read. */
	readonly serving: () => boolean;
	/** The supervisor's clock, in milliseconds since the epoch, against which held credentials are tested for their end. */
	readonly nowMilliseconds: () => number;
	readonly log: LogEmitter;
};

/**
 * The supervisor's local channel to its per-turn child: one operation, reading the credentials of the dispatch being served.
 * It listens on a Unix domain socket in a directory only root can enter, sets the file to mode 0600 as soon as it is bound
 * (the directory keeps every other user out in the instant before), refuses to serve on a file with any other mode, and
 * answers one newline-terminated JSON request of at most 1 KiB per connection with one newline-terminated JSON answer. It
 * never returns the supervisor's own credentials or token, and answers nothing for a dispatch that is not the one being served.
 * Every request is logged as `owner_credential_socket` with the operation and the outcome, never a value.
 */
export class SupervisorSocketServer {
	private readonly socketPath: string;
	private readonly options: SupervisorSocketServerOptions;
	private server: Server | null = null;
	private readonly connections = new Set<Socket>();

	constructor(options: SupervisorSocketServerOptions) {
		this.options = options;
		this.socketPath = options.socketPath ?? OWNER_SUPERVISOR_SOCKET_PATH;
	}

	/**
	 * Remove a stale socket left by an earlier supervisor, bind the new one, give it {@link OWNER_SOCKET_FILE_MODE}, and begin serving.
	 * The directory must already exist and be locked to root.
	 *
	 * @throws Error If the socket cannot be bound or its file does not have the mode {@link OWNER_SOCKET_FILE_MODE}.
	 */
	async start(): Promise<void> {
		rmSync(this.socketPath, { force: true });
		const server = createServer((connection) => this.accept(connection));
		server.maxConnections = OWNER_SOCKET_MAXIMUM_CONNECTIONS;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.socketPath, () => {
				server.off("error", reject);
				resolve();
			});
		});
		chmodSync(this.socketPath, OWNER_SOCKET_FILE_MODE);
		const mode = lstatSync(this.socketPath).mode & 0o777;
		if (mode !== OWNER_SOCKET_FILE_MODE) {
			server.close();
			rmSync(this.socketPath, { force: true });
			throw new Error(`the supervisor socket has mode ${mode.toString(8)}, expected ${OWNER_SOCKET_FILE_MODE.toString(8)}`);
		}
		server.on("error", () => undefined);
		this.server = server;
	}

	/** Stop serving, close every open connection and remove the socket file. */
	async close(): Promise<void> {
		const server = this.server;
		this.server = null;
		if (server === null) return;
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
			for (const connection of this.connections) connection.destroy();
		});
		rmSync(this.socketPath, { force: true });
	}

	private accept(connection: Socket): void {
		this.connections.add(connection);
		connection.once("close", () => this.connections.delete(connection));
		if (!this.options.serving()) {
			this.options.log("owner_credential_socket", { op: "none", outcome: "no_turn" satisfies SocketOutcome });
			connection.destroy();
			return;
		}
		let received = Buffer.alloc(0);
		let answered = false;
		const answer = (response: SocketResponse, outcome: SocketOutcome, dispatchId: string | null): void => {
			if (answered) return;
			answered = true;
			this.options.log("owner_credential_socket", { op: dispatchId === null ? "unknown" : "turn_credentials", outcome, ...(dispatchId === null ? {} : { dispatch_id: dispatchId }) });
			connection.end(`${JSON.stringify(response)}\n`);
		};
		connection.setTimeout(OWNER_SOCKET_REQUEST_TIMEOUT_MILLISECONDS, () => connection.destroy());
		connection.on("error", () => connection.destroy());
		connection.on("data", (chunk) => {
			if (answered) return;
			received = Buffer.concat([received, chunk]);
			const newline = received.indexOf(0x0a);
			if (newline === -1 && received.length <= OWNER_SOCKET_MAXIMUM_REQUEST_BYTES) return;
			if (newline === -1 || newline + 1 > OWNER_SOCKET_MAXIMUM_REQUEST_BYTES) {
				answer({ ok: false, code: "no_turn" }, "malformed", null);
				return;
			}
			this.respondTo(received.subarray(0, newline).toString("utf8"), answer);
		});
	}

	private respondTo(line: string, answer: (response: SocketResponse, outcome: SocketOutcome, dispatchId: string | null) => void): void {
		let parsed: ReturnType<typeof ownerSocketRequestSchema.safeParse>;
		try {
			parsed = ownerSocketRequestSchema.safeParse(JSON.parse(line));
		} catch {
			answer({ ok: false, code: "no_turn" }, "malformed", null);
			return;
		}
		if (!parsed.success) {
			answer({ ok: false, code: "no_turn" }, "malformed", null);
			return;
		}
		const dispatchId = parsed.data.dispatch_id;
		const held = this.options.source.current(dispatchId);
		if (held === null) {
			answer({ ok: false, code: "no_turn" }, "no_turn", dispatchId);
			return;
		}
		const endsAtMilliseconds = Math.min(Date.parse(held.aws_credentials.expires_at), Date.parse(held.expires_at));
		if (!(endsAtMilliseconds > this.options.nowMilliseconds())) {
			answer({ ok: false, code: "expired" }, "expired", dispatchId);
			return;
		}
		answer({ ok: true, aws_credentials: held.aws_credentials, gateway_token: held.gateway_token, expires_at: held.expires_at }, "ok", dispatchId);
	}
}
