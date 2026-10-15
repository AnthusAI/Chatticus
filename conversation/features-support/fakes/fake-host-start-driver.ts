import type { ComputerStartJob, HostStartDriver } from "../../src/domain/computer-start.ts";
import type { HostStartClaim } from "../../src/domain/computers.ts";

/** One call the starter made to the driver. */
export type HostStartInvocation = { readonly claim: HostStartClaim; readonly job: ComputerStartJob };

/**
 * The system that starts the computer's host (ECS `run_task`, or a local process), faked: it records every start it is
 * asked for and, when given a boot hook, brings the fake host up the way a started host boots.
 */
export class FakeHostStartDriver implements HostStartDriver {
	readonly invocations: HostStartInvocation[] = [];
	private readonly boot: ((claim: HostStartClaim) => Promise<void>) | null;

	/** @param boot What the started host does as it boots; absent for a driver that only records. */
	constructor(boot: ((claim: HostStartClaim) => Promise<void>) | null = null) {
		this.boot = boot;
	}

	async start(claim: HostStartClaim, job: ComputerStartJob): Promise<void> {
		this.invocations.push({ claim, job });
		await this.boot?.(claim);
	}
}
