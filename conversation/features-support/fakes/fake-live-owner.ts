import {
	ownerFileResultRequestSchema,
	type LiveFileOutcome,
	type OwnerFileRequest,
} from "@chatticus/host-protocol/live-files";
import { ownerPollResponseSchema, type OwnerPollResponse, type OwnerState, type OwnerStopResponse } from "@chatticus/host-protocol/supervisor";

/** The front door a fake owner talks to, and the identity and token it speaks with. */
export type FakeLiveOwnerWire = {
	readonly app: { request(path: string, init?: RequestInit): Response | Promise<Response> };
	readonly tenantId: string;
	readonly ownerId: string;
	readonly generation: number;
	readonly token: string;
};

/** One answer of the control plane: the status and the parsed or raw body. */
export type FakeLiveOwnerAnswer = { readonly status: number; readonly body: any };

/** What one poll of the fake owner may change from the default of an idle owner on protocol 2 with the next sequence number. */
export type FakeLiveOwnerPollOptions = {
	readonly state?: OwnerState;
	readonly protocolVersion?: number;
	/** Send the sequence of the previous poll again, as an owner that did not hear the answer does. */
	readonly repeat?: boolean;
};

/**
 * The owner side of the live file protocol as a scenario drives it over the real HTTP routes: it polls with its
 * supervisor token, remembers the file requests it was given, and posts results. It runs no helper and opens no disk; the
 * scenario decides what each answer says.
 */
export class FakeLiveOwner {
	readonly wire: FakeLiveOwnerWire;
	readonly receivedRequests: OwnerFileRequest[] = [];
	lastPoll: OwnerPollResponse | null = null;
	lastState: OwnerState = "idle";
	private sequence = 0;
	private lastBody: Record<string, unknown> | null = null;

	/** @param wire The front door, identity and supervisor token. */
	constructor(wire: FakeLiveOwnerWire) {
		this.wire = wire;
	}

	private async send(suffix: string, body: unknown): Promise<FakeLiveOwnerAnswer> {
		const response = await this.wire.app.request(`/orgs/${this.wire.tenantId}/host${suffix}`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${this.wire.token}` },
			body: JSON.stringify(body),
		});
		const text = await response.text();
		try {
			return { status: response.status, body: JSON.parse(text) };
		} catch {
			return { status: response.status, body: text };
		}
	}

	/**
	 * Poll once. A serving owner reports the one turn it serves.
	 *
	 * @param options The state, protocol version and whether to repeat the previous sequence number.
	 * @returns The answer; a 200 is parsed against the poll response schema and its file requests are remembered.
	 */
	async poll(options: FakeLiveOwnerPollOptions = {}): Promise<FakeLiveOwnerAnswer> {
		const state = options.state ?? this.lastState;
		if (options.repeat !== true || this.lastBody === null) this.sequence += 1;
		const body = {
			owner_id: this.wire.ownerId,
			generation: this.wire.generation,
			protocol_version: options.protocolVersion ?? 2,
			sequence: this.sequence,
			state,
			active_turns: state === "serving" ? [{ turn_id: "turn-being-served", dispatch_id: "dispatch-being-served" }] : [],
		};
		this.lastBody = body;
		const answer = await this.send("/owner/poll", body);
		if (answer.status === 200) {
			this.lastState = state;
			this.lastPoll = ownerPollResponseSchema.parse(answer.body);
			this.receivedRequests.push(...this.lastPoll.file_requests);
		}
		return answer;
	}

	/**
	 * Ask whether the owner may stop.
	 *
	 * @param reason Why it asks.
	 * @returns The control plane's judgment.
	 */
	async requestStop(reason: "idle" | "lifetime" | "unhealthy"): Promise<OwnerStopResponse> {
		const answer = await this.send("/owner/stop-request", {
			owner_id: this.wire.ownerId,
			generation: this.wire.generation,
			reason,
			active_turns: this.lastState === "serving" ? [{ turn_id: "turn-being-served", dispatch_id: "dispatch-being-served" }] : [],
		});
		if (answer.status !== 200) throw new Error(`The stop request was answered ${answer.status}: ${JSON.stringify(answer.body)}`);
		return answer.body as OwnerStopResponse;
	}

	/**
	 * Post the answer to one request.
	 *
	 * @param operationId The request answered.
	 * @param outcome The result or the error.
	 * @returns The answer; the body is validated by the control plane, not here, so a scenario can post a wrong one.
	 */
	async postResult(operationId: string, outcome: LiveFileOutcome): Promise<FakeLiveOwnerAnswer> {
		return this.send("/owner/file-results", {
			owner_id: this.wire.ownerId,
			generation: this.wire.generation,
			operation_id: operationId,
			outcome,
		});
	}

	/**
	 * Post a result the way the protocol schema says it is shaped, failing the scenario if the fake built it wrongly.
	 *
	 * @param operationId The request answered.
	 * @param outcome The result or the error.
	 * @returns The answer.
	 */
	async postValidResult(operationId: string, outcome: LiveFileOutcome): Promise<FakeLiveOwnerAnswer> {
		ownerFileResultRequestSchema.parse({ owner_id: this.wire.ownerId, generation: this.wire.generation, operation_id: operationId, outcome });
		return this.postResult(operationId, outcome);
	}
}
