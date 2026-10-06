/**
 * Starting the organization's computer host for a parked turn.
 *
 * A turn that parks on a computer action while no live host serves its computer publishes a `ComputerStartJob`. The
 * starter (the old ComputerWorker without turn logic) consumes it: it refuses work the spend ceiling blocks, asks for a
 * host start under the computer's lease (one start per generation, however many jobs arrive), and calls the host start
 * driver once. It does not wait for the host: the host finds its work by claiming actions when it boots.
 *
 * Ported from python/src/chatticus/worker/computer.py `_dispatch_host_start_if_needed` and
 * `_deny_continuation_for_spend_ceiling`.
 */

import {
	ComputerWorkerHostNotReady,
	ComputerWorkerRequiresComputerCapability,
	OrganizationComputerProvisioningError,
	OrganizationSpendCeilingExceededError,
} from "../http/errors.ts";
import { answerComputerActionOnOwnAccount, type ActionDependencies } from "./actions.ts";
import { type HostStartClaim, type HostStartDependencies, requestComputerHostStart } from "./computers.ts";
import type { TurnJob } from "./workers.ts";

export { ComputerWorkerHostNotReady, ComputerWorkerRequiresComputerCapability };

/** The job that asks the starter to bring up the computer host for one parked turn. */
export type ComputerStartJob = {
	readonly jobId: string;
	readonly tenantId: string;
	readonly turnId: string;
	readonly botId: string;
	/** The member the turn runs for. */
	readonly userId: string;
	readonly computerId: string;
	readonly computerPolicy: TurnJob["computerPolicy"];
	readonly requiredCapabilities: readonly string[];
};

/** Where start jobs are published; the ComputerStarter consumes them. */
export interface ComputerStartQueue {
	enqueue(job: ComputerStartJob): Promise<void>;
}

/** The driver that starts the host (ECS `run_task`, or a local process): an external system. */
export interface HostStartDriver {
	start(claim: HostStartClaim, job: ComputerStartJob): Promise<void>;
}

/** What the starter reads and writes. */
export type ComputerStarterDependencies = HostStartDependencies &
	ActionDependencies & {
		readonly driver: HostStartDriver;
		/** Called for each turn whose actions the starter answered, so the turn resumes. */
		readonly resumeTurn: (tenantId: string, turnId: string) => Promise<void>;
	};

/** How handling one start job ended. */
export type ComputerStartOutcome =
	| { readonly kind: "started"; readonly hostStartGeneration: number }
	| { readonly kind: "already_started"; readonly hostStartGeneration: number }
	| { readonly kind: "refused"; readonly reason: string };

/** The result a turn reads for an action the spend ceiling stopped after it was parked. */
export const deniedActionResult = (reason: string): string => `denied: ${reason}`;

/**
 * Handle one start job. A refused job (the spend ceiling) answers the turn's open actions with a denial and resumes the
 * turn, so it ends visibly instead of waiting out its limit; the job is then done. A job that finds the generation
 * already started does nothing more.
 *
 * @param deps Stores, clock, the host start driver and how to resume a turn.
 * @param job The start job.
 * @returns How it ended.
 * @throws ComputerWorkerRequiresComputerCapability If the job does not need the computer capability.
 * @throws ComputerWorkerHostNotReady If the driver could not start the host; the job should be retried.
 */
export async function handleComputerStartJob(
	deps: ComputerStarterDependencies,
	job: ComputerStartJob,
): Promise<ComputerStartOutcome> {
	if (!job.requiredCapabilities.includes("computer")) {
		throw new ComputerWorkerRequiresComputerCapability(
			`Job ${JSON.stringify(job.jobId)} does not require the computer capability.`,
		);
	}
	let claim: HostStartClaim;
	try {
		claim = await requestComputerHostStart(deps, job.tenantId, job.userId);
	} catch (error) {
		if (!(error instanceof OrganizationSpendCeilingExceededError)) throw error;
		await denyOpenActionsOfTurn(deps, job, error.message);
		return { kind: "refused", reason: error.message };
	}
	if (!(await deps.store.markHostStartDispatched(job.tenantId, claim.hostStartGeneration))) {
		return { kind: "already_started", hostStartGeneration: claim.hostStartGeneration };
	}
	try {
		await deps.driver.start(claim, job);
	} catch (error) {
		await deps.store.releaseHostStartDispatch(job.tenantId, claim.hostStartGeneration);
		if (error instanceof OrganizationComputerProvisioningError) {
			throw new ComputerWorkerHostNotReady(`Turn ${JSON.stringify(job.turnId)} computer provisioning refused: ${error.message}`);
		}
		throw new ComputerWorkerHostNotReady(`Turn ${JSON.stringify(job.turnId)} host start failed: ${(error as Error).message}.`);
	}
	return { kind: "started", hostStartGeneration: claim.hostStartGeneration };
}

async function denyOpenActionsOfTurn(deps: ComputerStarterDependencies, job: ComputerStartJob, reason: string): Promise<void> {
	for (const action of await deps.actions.listForTurn(job.tenantId, job.turnId)) {
		if (action.status === "done") continue;
		await answerComputerActionOnOwnAccount(deps, action, { result: deniedActionResult(reason), isError: true });
	}
	await deps.resumeTurn(job.tenantId, job.turnId);
}
