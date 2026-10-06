import type { HostAction, RegateActionRequest } from "@chatticus/host-protocol";
import type { SnapshotObjectStore } from "../../../conversation/src/snapshot/store.ts";
import { ComputerHostBootDriver, type HostBootPlane } from "./boot.ts";
import { publishBeforeExit } from "./disk-lifecycle.ts";
import { HostActionExecutor } from "./host-action-executor.ts";
import { HostProtocolClient, registerHostWorker } from "./protocol-client.ts";

const DEFAULT_WORKER_ID = "computer-host";
const DEFAULT_HOST_WORKER_SECONDS = 120;
const IDLE_SLEEP_MILLISECONDS = 1000;
const BROWSER_TOOLS: ReadonlySet<string> = new Set(["browser_open", "request_computer_capability"]);

/** A required environment variable is missing. Python raised the built-in `KeyError`; the host keeps the name. */
export class KeyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "KeyError";
	}
}

/** What the host worker asks of the Front Door. */
export type HostWorkerPlane = HostBootPlane & Pick<HostProtocolClient, "claimAction" | "postActionResult" | "regateAction">;

/** What runs one claimed action's tool. */
export interface HostActionRunner {
	execute(toolName: string, arguments_: Readonly<Record<string, string>>): Promise<string>;
}

/**
 * The regate one claimed action needs before it runs: the origin or path its tool reaches. The Front Door answers it with
 * the verdict of the same gate the executor used for the turn.
 *
 * @param action The claimed action.
 * @returns The regate to ask for, or null when the action reaches nothing the gate checks.
 */
export function regateRequestFor(action: HostAction): RegateActionRequest | null {
	if (BROWSER_TOOLS.has(action.tool_name)) {
		const url = (action.arguments["url"] ?? "").trim();
		return url === "" || url === "about:blank" ? null : { kind: "browse", target: url };
	}
	if (action.tool_name === "read_workspace") {
		const path = (action.arguments["path"] ?? "").trim();
		return path === "" ? null : { kind: "read", target: path };
	}
	if (action.tool_name === "write_workspace") {
		const path = (action.arguments["path"] ?? "").trim();
		return path === "" ? null : { kind: "write", target: path };
	}
	return null;
}

/**
 * Run one claimed action and report what it answered. The action is re-gated first; a refused regate is reported as the
 * error `denied: <reason>` and the tool never runs. A tool that throws is reported as its error.
 *
 * @param plane The Front Door.
 * @param action The claimed action.
 * @param executor The host's tools.
 */
export async function runClaimedAction(plane: HostWorkerPlane, action: HostAction, executor: HostActionRunner): Promise<void> {
	const regate = regateRequestFor(action);
	if (regate !== null) {
		const verdict = await plane.regateAction(action.action_id, regate);
		if (!verdict.allowed) {
			await plane.postActionResult(action.action_id, { error: `denied: ${verdict.detail}` });
			return;
		}
	}
	let answer: { result: string } | { error: string };
	try {
		answer = { result: await executor.execute(action.tool_name, action.arguments) };
	} catch (error) {
		answer = { error: (error as Error).message };
	}
	await plane.postActionResult(action.action_id, answer);
}

/**
 * Claim the next computer action, run it and report its result.
 *
 * @param plane The Front Door.
 * @param executor The host's tools.
 * @returns The action that was run, or null when nothing was waiting for this host.
 */
export async function runHostWorkerOnce(plane: HostWorkerPlane, executor: HostActionRunner): Promise<HostAction | null> {
	const action = await plane.claimAction();
	if (action === null) {
		return null;
	}
	await runClaimedAction(plane, action, executor);
	return action;
}

/** What shutting the host down needs. */
export type ShutdownHostWorkerOptions = {
	readonly tenantId: string;
	readonly workerId?: string;
	readonly liveRoot?: string;
	readonly store?: SnapshotObjectStore | null;
};

/**
 * Publish a dirty disk and mark the household computer stopped.
 *
 * @param plane The Front Door.
 * @param options The organization, the worker, the live root and the store.
 */
export async function shutdownHostWorker(plane: HostWorkerPlane, options: ShutdownHostWorkerOptions): Promise<void> {
	await publishBeforeExit(plane, {
		tenantId: options.tenantId,
		workerId: options.workerId ?? DEFAULT_WORKER_ID,
		...(options.liveRoot === undefined ? {} : { liveRoot: options.liveRoot }),
		...(options.store === undefined ? {} : { store: options.store }),
	});
	await plane.setComputerStopped(true);
}

/** What the host worker loop runs on. */
export type HostWorkerLoopOptions = {
	readonly plane: HostWorkerPlane;
	readonly bootDriver: ComputerHostBootDriver;
	readonly executor: HostActionRunner;
	readonly tenantId: string;
	readonly workerId?: string;
	readonly liveRoot?: string;
	readonly store?: SnapshotObjectStore | null;
	/** The time, in epoch milliseconds, after which the loop stops claiming. */
	readonly deadlineMilliseconds: number;
	readonly now?: () => number;
	readonly sleep?: (milliseconds: number) => Promise<void>;
};

/**
 * Boot the host (hydrating its disk), then claim, run and report actions until the deadline, and publish the disk
 * before returning.
 *
 * @param options The Front Door, the boot driver, the tools and the deadline.
 * @returns The actions that were run, in order.
 */
export async function runHostWorker(options: HostWorkerLoopOptions): Promise<HostAction[]> {
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
	const ran: HostAction[] = [];
	await options.bootDriver.bootThroughBrowser();
	try {
		while (now() < options.deadlineMilliseconds) {
			const action = await runHostWorkerOnce(options.plane, options.executor);
			if (action === null) {
				await sleep(IDLE_SLEEP_MILLISECONDS);
			} else {
				ran.push(action);
			}
		}
	} finally {
		await shutdownHostWorker(options.plane, {
			tenantId: options.tenantId,
			...(options.workerId === undefined ? {} : { workerId: options.workerId }),
			...(options.liveRoot === undefined ? {} : { liveRoot: options.liveRoot }),
			...(options.store === undefined ? {} : { store: options.store }),
		});
	}
	return ran;
}

/**
 * Entry point for the Fargate computer container override.
 *
 * @throws KeyError If the organization, the member or the Front Door is not named in the environment.
 */
export async function main(): Promise<void> {
	const tenantId = (process.env["CHATTICUS_TENANT_ID"] ?? "").trim();
	const userId = (process.env["CHATTICUS_USER_ID"] ?? "").trim();
	if (tenantId === "" || userId === "") {
		throw new KeyError("CHATTICUS_TENANT_ID and CHATTICUS_USER_ID are required");
	}
	const baseUrl = (process.env["CHATTICUS_FRONT_DOOR_URL"] ?? "").trim().replace(/\/+$/, "");
	if (baseUrl === "") {
		throw new KeyError("CHATTICUS_FRONT_DOOR_URL");
	}
	console.info(`computer_host_worker_start tenant_id=${tenantId} user_id=${userId}`);
	const invokeKey = (process.env["CHATTICUS_INVOKE_KEY"] ?? "").trim();
	const deadlineMilliseconds = Date.now() + Number.parseInt(process.env["CHATTICUS_HOST_WORKER_SECONDS"] ?? `${DEFAULT_HOST_WORKER_SECONDS}`, 10) * 1000;
	const workerToken = await registerHostWorker({ baseUrl, tenantId, workerId: DEFAULT_WORKER_ID, invokeKey });
	const plane = new HostProtocolClient({ baseUrl, tenantId, workerToken, userId, invokeKey });
	await runHostWorker({
		plane,
		bootDriver: new ComputerHostBootDriver(plane, { tenantId, workerId: DEFAULT_WORKER_ID }),
		executor: new HostActionExecutor(),
		tenantId,
		workerId: DEFAULT_WORKER_ID,
		deadlineMilliseconds,
	});
}

if (import.meta.main) {
	await main();
}
