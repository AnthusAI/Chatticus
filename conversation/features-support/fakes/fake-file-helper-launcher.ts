import type { FileHelperLauncher, FileHelperRequest, FileHelperResponse } from "../../../computer/host/src/live-file-helper-launcher.ts";
import type { SupervisorClock } from "../../../computer/host/src/supervisor-ports.ts";
import { runOwnerFileRequest } from "../../src/pi/owner-file-helper.ts";

/**
 * The file helper launcher of a supervisor scenario. It runs the real helper, either as a real process through a plain shell
 * launcher or in this process, and it can take fake time to do it, never answer, and tell the scenario what it was asked
 * and what is still running. A request that is never answered ends at the timeout on the fake clock, as the real launcher
 * kills the helper at its timeout.
 */
export class ScenarioFileHelperLauncher implements FileHelperLauncher {
	/** Every request the supervisor handed the helper, in order. */
	readonly requests: FileHelperRequest[] = [];
	/** Fake milliseconds every run takes before the helper does its work. */
	delayMilliseconds = 0;
	/** The helper never answers; each run ends at its timeout. */
	hangs = false;
	/** Run the helper as a process through the real launcher; otherwise run it in this process. */
	useRealProcess = true;
	/** Called after the helper answered a request, before the supervisor sees the answer. */
	afterRun: (request: FileHelperRequest, response: FileHelperResponse) => void = () => undefined;
	/** Called with each request the moment the supervisor hands it over, before any fake time passes. */
	onRequest: (request: FileHelperRequest) => void = () => undefined;
	running = 0;
	killedAtTimeout = 0;

	private readonly clock: SupervisorClock;
	private readonly processLauncher: FileHelperLauncher;

	constructor(clock: SupervisorClock, processLauncher: FileHelperLauncher) {
		this.clock = clock;
		this.processLauncher = processLauncher;
	}

	async run(request: FileHelperRequest, timeoutMilliseconds: number): Promise<FileHelperResponse> {
		this.requests.push(request);
		this.onRequest(request);
		this.running += 1;
		try {
			if (this.hangs) {
				await this.clock.sleep(timeoutMilliseconds);
				this.killedAtTimeout += 1;
				return { ok: false, code: "helper_timeout", message: "The file helper did not answer in time and was stopped." };
			}
			if (this.delayMilliseconds > 0) await this.clock.sleep(this.delayMilliseconds);
			const response = this.useRealProcess ? await this.processLauncher.run(request, timeoutMilliseconds) : await runOwnerFileRequest(request);
			this.afterRun(request, response);
			return response;
		} finally {
			this.running -= 1;
		}
	}
}

/** The launcher of a scenario that never receives a file request; if one arrives, the helper fails. */
export const UNUSED_FILE_HELPER_LAUNCHER: FileHelperLauncher = {
	run: async () => ({ ok: false, code: "helper_failed", message: "This scenario has no file helper." }),
};
