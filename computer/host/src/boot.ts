import { spawn, type ChildProcess } from "node:child_process";
import type { SnapshotObjectStore } from "../../../conversation/src/snapshot/store.ts";
import { hydrateOnBoot, type HostDiskPlane } from "./disk-lifecycle.ts";
import { RuntimeError, runProcessOnHost, verifyChromiumAvailable } from "./executors/chromium.ts";
import type { HostProtocolClient } from "./protocol-client.ts";
import { pythonRepr } from "./workspace-paths.ts";

const DEFAULT_DISPLAY = ":99";
const XVFB_SCREEN = "1280x720x24";
const XVFB_READY_SECONDS = 5;
const XVFB_POLL_MILLISECONDS = 100;
const XVFB_STOP_SECONDS = 5;
const MODEL_CAPABILITY = "model";
const WORKSPACE_CAPABILITY = "workspace";
const BROWSER_CAPABILITY = "browser";

/** Observed host boot progress for one household computer. */
export type ComputerHostBootResult = {
	readonly display: string;
	readonly browserAvailable: boolean;
	readonly chromiumVersion: string | null;
	readonly browserUnavailableReason: string | null;
	readonly readinessOrder: readonly string[];
};

/** The display the browser draws on: started only for the browser gate, stopped when the host exits. */
export interface DisplayServer {
	start(): Promise<void>;
	stop(): Promise<void>;
}

/** The probe that returns the Chromium version line on one display. The browser is behind this port; tests fake it. */
export type ChromiumProbe = (display: string) => Promise<string>;

/** What the boot driver asks of the Front Door. */
export type HostBootPlane = HostDiskPlane & Pick<HostProtocolClient, "setComputerStopped" | "recordComputerCapabilityReady" | "recordComputerCapabilityUnavailable">;

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Start one Xvfb display for the computer host. */
export class XvfbProcess implements DisplayServer {
	readonly display: string;
	private process: ChildProcess | null = null;

	constructor(display: string = DEFAULT_DISPLAY) {
		this.display = display;
	}

	/**
	 * Launch Xvfb when it is not already serving this display.
	 *
	 * @throws RuntimeError If Xvfb is not installed or the display does not become ready in time.
	 */
	async start(): Promise<void> {
		if (this.process !== null && this.process.exitCode === null && this.process.signalCode === null) {
			return;
		}
		const launched = spawn("Xvfb", [this.display, "-screen", "0", XVFB_SCREEN, "-nolisten", "tcp"], { stdio: "ignore" });
		const failure: { error: Error | null } = { error: null };
		launched.once("error", (error) => {
			failure.error = error;
		});
		this.process = launched;
		process.env["DISPLAY"] = this.display;
		const deadline = Date.now() + XVFB_READY_SECONDS * 1000;
		while (Date.now() < deadline) {
			if (failure.error !== null) {
				this.process = null;
				throw new RuntimeError(`Xvfb could not start: ${failure.error.message}`);
			}
			const probe = await runProcessOnHost(["xdpyinfo", "-display", this.display], {
				environment: process.env,
				timeoutMilliseconds: XVFB_READY_SECONDS * 1000,
			}).catch(() => ({ returnCode: 1, standardOutput: "", standardError: "" }));
			if (probe.returnCode === 0) {
				return;
			}
			await sleep(XVFB_POLL_MILLISECONDS);
		}
		throw new RuntimeError(`Xvfb did not become ready on display ${pythonRepr(this.display)}.`);
	}

	/** Terminate the Xvfb process when this host started it. */
	async stop(): Promise<void> {
		const running = this.process;
		if (running === null) {
			return;
		}
		if (running.exitCode === null && running.signalCode === null) {
			running.kill("SIGTERM");
			const exited = new Promise<void>((resolve) => running.once("exit", () => resolve()));
			const timedOut = await Promise.race([exited.then(() => false), sleep(XVFB_STOP_SECONDS * 1000).then(() => true)]);
			if (timedOut) {
				running.kill("SIGKILL");
			}
		}
		this.process = null;
	}
}

/** What one boot driver brings up. */
export type ComputerHostBootDriverOptions = {
	readonly tenantId?: string;
	readonly workerId?: string;
	readonly display?: string;
	readonly xvfb?: DisplayServer;
	readonly chromiumProbe?: ChromiumProbe;
	readonly liveRoot?: string;
	readonly store?: SnapshotObjectStore | null;
};

/** Bring one computer host through model, workspace, and browser gates. */
export class ComputerHostBootDriver {
	readonly plane: HostBootPlane;
	readonly tenantId: string;
	readonly workerId: string;
	readonly display: string;
	readonly readinessOrder: string[] = [];
	lastBoot: ComputerHostBootResult | null = null;
	private readonly xvfb: DisplayServer;
	private readonly chromiumProbe: ChromiumProbe;
	private readonly liveRoot: string | undefined;
	private readonly store: SnapshotObjectStore | null | undefined;

	constructor(plane: HostBootPlane, options: ComputerHostBootDriverOptions = {}) {
		this.plane = plane;
		this.tenantId = options.tenantId ?? "anthus";
		this.workerId = options.workerId ?? "computer-host";
		this.display = options.display ?? DEFAULT_DISPLAY;
		this.xvfb = options.xvfb ?? new XvfbProcess(this.display);
		this.chromiumProbe = options.chromiumProbe ?? ((display) => verifyChromiumAvailable({ display }));
		this.liveRoot = options.liveRoot;
		this.store = options.store;
	}

	/** Clear the model gate, hydrate the disk, and clear the workspace gate. Neither waits on the browser. */
	async bootThroughWorkspace(): Promise<void> {
		await this.plane.setComputerStopped(false);
		await this.plane.recordComputerCapabilityReady(MODEL_CAPABILITY);
		this.readinessOrder.push(MODEL_CAPABILITY);
		await hydrateOnBoot(this.plane, {
			tenantId: this.tenantId,
			workerId: this.workerId,
			...(this.liveRoot === undefined ? {} : { liveRoot: this.liveRoot }),
			...(this.store === undefined ? {} : { store: this.store }),
		});
		await this.plane.recordComputerCapabilityReady(WORKSPACE_CAPABILITY);
		this.readinessOrder.push(WORKSPACE_CAPABILITY);
	}

	/**
	 * Boot through model and workspace, then try the browser capability. A computer without a browser, or whose display
	 * does not start, reports the browser capability unavailable and stays up for files and the terminal; it is never a
	 * boot failure.
	 */
	async bootThroughBrowser(): Promise<ComputerHostBootResult> {
		await this.bootThroughWorkspace();
		let chromiumVersion: string | null = null;
		let browserUnavailableReason: string | null = null;
		try {
			await this.xvfb.start();
			chromiumVersion = await this.chromiumProbe(this.display);
		} catch (error) {
			browserUnavailableReason = error instanceof Error ? error.message : String(error);
			await this.xvfb.stop().catch(() => undefined);
		}
		if (chromiumVersion === null) {
			await this.plane.recordComputerCapabilityUnavailable(BROWSER_CAPABILITY);
		} else {
			await this.plane.recordComputerCapabilityReady(BROWSER_CAPABILITY);
			this.readinessOrder.push(BROWSER_CAPABILITY);
		}
		const result: ComputerHostBootResult = {
			display: this.display,
			browserAvailable: chromiumVersion !== null,
			chromiumVersion,
			browserUnavailableReason,
			readinessOrder: [...this.readinessOrder],
		};
		this.lastBoot = result;
		return result;
	}
}
