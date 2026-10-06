import {
	HOST_USER_HEADER,
	actionResultResponseSchema,
	claimActionRequestSchema,
	claimActionResponseSchema,
	computerStateRequestSchema,
	heartbeatRequestSchema,
	hostComputerSchema,
	hostStatusResponseSchema,
	regateActionRequestSchema,
	regateActionResponseSchema,
	renewActionRequestSchema,
	renewActionResponseSchema,
	snapshotHydratedRequestSchema,
	snapshotPublishedRequestSchema,
	type ActionResultRequest,
	type HostAction,
	type HostComputer,
	type RegateActionRequest,
} from "@chatticus/host-protocol";

const INVOKE_HEADER = "X-Chatticus-Invoke-Key";
const DEFAULT_REGISTRATION_COST_CLASS = "local";
const DEFAULT_REGISTRATION_CAPABILITIES = ["cpu", "computer"];

/** The Front Door refused a host request. Python raised the built-in `RuntimeError`; the host keeps a named class. */
export class HostProtocolError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "HostProtocolError";
		this.status = status;
	}
}

/** The verdict of the Front Door on a regate: allowed, or refused with the reason it gave. */
export type RegateVerdict = { readonly allowed: true } | { readonly allowed: false; readonly detail: string };

/** What one host talks to the Front Door with. */
export type HostProtocolClientOptions = {
	/** The Front Door origin, with no trailing slash. */
	readonly baseUrl: string;
	readonly tenantId: string;
	/** The bearer token the worker registered for. */
	readonly workerToken: string;
	/** The member the host serves, named in the host user header of every request. */
	readonly userId: string;
	readonly invokeKey?: string;
	readonly fetchFunction?: typeof fetch;
};

type ZodLike<T> = { parse(value: unknown): T };

function messageOf(method: string, suffix: string, status: number, text: string): string {
	return `${method} ${suffix} failed with status ${status}: ${text}`;
}

/** The nine host routes of one organization's Front Door, called with one worker's bearer token. */
export class HostProtocolClient {
	private readonly options: HostProtocolClientOptions;
	private readonly fetchFunction: typeof fetch;

	constructor(options: HostProtocolClientOptions) {
		this.options = options;
		this.fetchFunction = options.fetchFunction ?? fetch;
	}

	private headers(): Record<string, string> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.options.workerToken}`,
			[HOST_USER_HEADER]: this.options.userId,
			"Content-Type": "application/json",
		};
		if (this.options.invokeKey) {
			headers[INVOKE_HEADER] = this.options.invokeKey;
		}
		return headers;
	}

	private async send(method: "GET" | "POST", suffix: string, body?: unknown): Promise<Response> {
		const url = `${this.options.baseUrl}/orgs/${this.options.tenantId}/host${suffix}`;
		return this.fetchFunction(url, {
			method,
			headers: this.headers(),
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	}

	private async request<T>(method: "GET" | "POST", suffix: string, schema: ZodLike<T>, body?: unknown): Promise<T> {
		const response = await this.send(method, suffix, body);
		const text = await response.text();
		if (response.status >= 400) {
			throw new HostProtocolError(messageOf(method, suffix, response.status, text), response.status);
		}
		return schema.parse(JSON.parse(text));
	}

	/** GET /computer: the organization's computer as the host reads it. */
	async getComputer(): Promise<HostComputer> {
		return this.request("GET", "/computer", hostComputerSchema);
	}

	/** POST /computer/state with `stopped`: the host says the computer is stopped or running. */
	async setComputerStopped(stopped: boolean): Promise<HostComputer> {
		return this.request("POST", "/computer/state", hostComputerSchema, computerStateRequestSchema.parse({ stopped }));
	}

	/** POST /computer/state with `capability_ready`: the host says one capability gate cleared. */
	async recordComputerCapabilityReady(capability: string): Promise<HostComputer> {
		return this.request("POST", "/computer/state", hostComputerSchema, computerStateRequestSchema.parse({ capability_ready: capability }));
	}

	/** POST /snapshot/hydrated: the host hydrated the published snapshot onto its disk. */
	async recordComputerHydrated(workerId: string): Promise<void> {
		await this.request("POST", "/snapshot/hydrated", hostStatusResponseSchema, snapshotHydratedRequestSchema.parse({ worker_id: workerId }));
	}

	/** POST /snapshot/published: the host packed its disk, uploaded it, and reports the checksum and where it went. */
	async publishComputerSnapshot(workerId: string, checksum: string, snapshotUri?: string): Promise<void> {
		await this.request(
			"POST",
			"/snapshot/published",
			hostStatusResponseSchema,
			snapshotPublishedRequestSchema.parse({ worker_id: workerId, checksum, ...(snapshotUri === undefined ? {} : { snapshot_uri: snapshotUri }) }),
		);
	}

	/** POST /actions/claim: the next action under a lease, or null when nothing waits for this host. */
	async claimAction(): Promise<HostAction | null> {
		return (await this.request("POST", "/actions/claim", claimActionResponseSchema, claimActionRequestSchema.parse({}))).action;
	}

	/** POST /actions/{id}/renew: extend the lease of the action this host holds. */
	async renewAction(actionId: string): Promise<HostAction> {
		return (await this.request("POST", `/actions/${actionId}/renew`, renewActionResponseSchema, renewActionRequestSchema.parse({}))).action;
	}

	/**
	 * POST /actions/{id}/result: what the tool answered, or the error it failed with.
	 *
	 * @returns Whether the turn parked on the action was resumed.
	 */
	async postActionResult(actionId: string, answer: ActionResultRequest): Promise<boolean> {
		const posted = await this.request("POST", `/actions/${actionId}/result`, actionResultResponseSchema, answer);
		return posted.turn_resumed;
	}

	/**
	 * POST /actions/{id}/regate: ask whether the action may reach one more origin or path.
	 *
	 * @returns Allowed, or refused with the Front Door's reason; any other failure is thrown.
	 */
	async regateAction(actionId: string, request: RegateActionRequest): Promise<RegateVerdict> {
		const suffix = `/actions/${actionId}/regate`;
		const response = await this.send("POST", suffix, regateActionRequestSchema.parse(request));
		const text = await response.text();
		if (response.status === 403) {
			return { allowed: false, detail: String((JSON.parse(text) as { detail?: unknown }).detail) };
		}
		if (response.status >= 400) {
			throw new HostProtocolError(messageOf("POST", suffix, response.status, text), response.status);
		}
		regateActionResponseSchema.parse(JSON.parse(text));
		return { allowed: true };
	}

	/** POST /heartbeat: the host is alive. */
	async heartbeat(): Promise<void> {
		await this.request("POST", "/heartbeat", hostStatusResponseSchema, heartbeatRequestSchema.parse({}));
	}
}

/** What registering a worker needs. */
export type RegisterHostWorkerOptions = {
	readonly baseUrl: string;
	readonly tenantId: string;
	readonly workerId: string;
	readonly invokeKey?: string;
	readonly fetchFunction?: typeof fetch;
};

/**
 * Register the host as a worker of the organization and return its bearer token.
 *
 * @param options The Front Door, the organization and the worker id.
 * @throws HostProtocolError If the Front Door refuses the registration.
 */
export async function registerHostWorker(options: RegisterHostWorkerOptions): Promise<string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (options.invokeKey) {
		headers[INVOKE_HEADER] = options.invokeKey;
	}
	const response = await (options.fetchFunction ?? fetch)(`${options.baseUrl}/orgs/${options.tenantId}/workers/register`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			worker_id: options.workerId,
			cost_class: DEFAULT_REGISTRATION_COST_CLASS,
			capabilities: DEFAULT_REGISTRATION_CAPABILITIES,
		}),
	});
	const text = await response.text();
	if (response.status >= 400) {
		throw new HostProtocolError(`worker register POST failed with status ${response.status}: ${text}`, response.status);
	}
	return String((JSON.parse(text) as { token: unknown }).token);
}
