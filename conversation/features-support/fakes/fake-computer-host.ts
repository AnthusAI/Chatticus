import assert from "node:assert/strict";
import { type RecordedResponse, recordResponse } from "../api.ts";
import type { ChatticusWorld } from "../world.ts";

/** One run of a tool on the fake host, counted whether or not its result was ever posted. */
export type HostExecution = {
	readonly actionId: string;
	readonly toolName: string;
	readonly arguments: Readonly<Record<string, string>>;
};

/** What the fake host's tool answers with: text and whether it is an error. */
export type HostToolResult = { readonly text: string; readonly isError: boolean };

/** The files of one computer's workspace, shared by every host that serves it. */
export type ComputerDisk = Map<string, string>;

/**
 * The host process of an organization's computer, faked. It speaks the real host protocol over the scenario's HTTP
 * front door with its own bearer token (claim an action, post its result), and runs tools deterministically against the
 * disk of the computer it serves. It never touches a store: the control plane is the system under test.
 */
export class FakeComputerHost {
	readonly executions: HostExecution[] = [];
	/** The last answer this host posted, so a scenario can post it again as a retrying host would. */
	lastPost: { actionId: string; result: HostToolResult } | null = null;
	readonly workerId: string;
	readonly tenantId: string;
	private readonly world: ChatticusWorld;
	private readonly token: string;
	private readonly disk: ComputerDisk;

	constructor(world: ChatticusWorld, tenantId: string, workerId: string, token: string, disk: ComputerDisk) {
		this.world = world;
		this.tenantId = tenantId;
		this.workerId = workerId;
		this.token = token;
		this.disk = disk;
	}

	private headers(): Record<string, string> {
		return { Authorization: `Bearer ${this.token}` };
	}

	private get api(): NonNullable<ChatticusWorld["api"]> {
		assert.ok(this.world.api, "The scenario has no HTTP front door.");
		return this.world.api;
	}

	/**
	 * Send one request over the host protocol with this host's bearer token, for the steps that exercise a single route.
	 *
	 * @param method GET or POST.
	 * @param path The route below `/orgs/{tenant}/host`.
	 * @param options The body to send, and headers to add to the bearer token.
	 */
	async request(
		method: "GET" | "POST",
		path: string,
		options: { body?: unknown; headers?: Record<string, string> } = {},
	): Promise<RecordedResponse> {
		const url = `/orgs/${this.tenantId}/host${path}`;
		const headers = { ...this.headers(), ...options.headers };
		return recordResponse(
			method === "GET" ? await this.api.get(url, { headers }) : await this.api.post(url, { headers, body: options.body ?? {} }),
		);
	}

	/** Refresh the host's heartbeat, as a live host does. */
	async heartbeat(): Promise<void> {
		const response = await recordResponse(await this.api.post(`/orgs/${this.tenantId}/host/heartbeat`, { headers: this.headers() }));
		assert.equal(response.status, 200, response.text);
	}

	/** Ask the control plane for the next computer action; null when there is none for this host. */
	async claim(): Promise<Record<string, any> | null> {
		const response = await recordResponse(
			await this.api.post(`/orgs/${this.tenantId}/host/actions/claim`, { headers: this.headers(), body: {} }),
		);
		assert.equal(response.status, 200, response.text);
		return response.json.action;
	}

	/** Run one claimed action's tool on the disk, counting the execution. */
	execute(action: Record<string, any>): HostToolResult {
		const args = action.arguments as Record<string, string>;
		this.executions.push({ actionId: action.action_id, toolName: action.tool_name, arguments: args });
		switch (action.tool_name) {
			case "read_workspace": {
				const content = this.disk.get(args["path"]!);
				return content === undefined
					? { text: `no such file: ${args["path"]}`, isError: true }
					: { text: content, isError: false };
			}
			case "write_workspace":
				this.disk.set(args["path"]!, args["content"] ?? "");
				return { text: `wrote ${args["path"]}`, isError: false };
			case "run_terminal":
				return { text: `ran: ${args["command"]}`, isError: false };
			case "browse":
				return { text: `opened ${args["url"]}`, isError: false };
			default:
				return { text: `capability ${args["capability"] ?? ""} ready`, isError: false };
		}
	}

	/** Post the answer of an action over the host protocol. */
	async postResult(actionId: string, result: HostToolResult): Promise<RecordedResponse> {
		this.lastPost = { actionId, result };
		return recordResponse(
			await this.api.post(`/orgs/${this.tenantId}/host/actions/${actionId}/result`, {
				headers: this.headers(),
				body: result.isError ? { error: result.text } : { result: result.text },
			}),
		);
	}

	/**
	 * Claim the next action, run it and post its result.
	 *
	 * @returns The action that was run, or null when nothing was waiting.
	 */
	async runNextAction(): Promise<Record<string, any> | null> {
		const action = await this.claim();
		if (action === null) return null;
		const posted = await this.postResult(action.action_id, this.execute(action));
		assert.equal(posted.status, 200, posted.text);
		return action;
	}
}
