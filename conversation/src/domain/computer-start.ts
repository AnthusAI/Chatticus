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
	OrganizationComputerNotSetUpError,
	OrganizationComputerProvisioningError,
	OrganizationSpendCeilingExceededError,
} from "../http/errors.ts";
import { consoleLogEmitter } from "../observability/log-line.ts";
import { answerComputerActionOnOwnAccount, type ActionDependencies, expireLostComputerActions } from "./actions.ts";
import { type HostStartClaim, type HostStartDependencies, requestComputerHostStart } from "./computers.ts";
import { failStaleTurn, type TurnDependencies } from "./turns.ts";
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
		/** Where a turn parked on a computer that can never start is failed. */
		readonly turns: TurnDependencies;
		/** Called for each action the starter answered, so the turn parked on it resumes. */
		readonly resumeTurn: (tenantId: string, turnId: string, actionId: string) => Promise<void>;
	};

/** How handling one start job ended. */
export type ComputerStartOutcome =
	| { readonly kind: "started"; readonly hostStartGeneration: number }
	| { readonly kind: "already_started"; readonly hostStartGeneration: number }
	| { readonly kind: "refused"; readonly reason: string };

/** What a person reads on a turn whose organization has no computer set up. */
export const COMPUTER_NOT_SET_UP_REASON =
	"This organization has no computer set up yet. Ask your Chatticus operator to set one up, then send your message again.";

/** The result a turn reads for an action the spend ceiling stopped after it was parked. */
export const deniedActionResult = (reason: string): string => `denied: ${reason}`;

/**
 * Handle one start job. First it settles the actions whose host was lost, so a lost lease needs no scheduler: whoever
 * handles the next start job notices it. A refused job (the spend ceiling) answers the turn's open actions with a denial
 * and resumes the turn, so it ends visibly instead of waiting out its limit; the job is then done. A job that finds the
 * generation already started does nothing more.
 *
 * @param deps Stores, clock, the host start driver and how to resume a turn.
 * @param job The start job.
 * @returns How it ended.
 * @throws ComputerWorkerRequiresComputerCapability If the job does not need the computer capability.
 * A permanent refusal (the organization has no AWS home, or no cross-account role) fails the parked turn with a plain
 * reason and ends the job without retry; every other driver failure is transient and the job should be retried.
 *
 * @throws ComputerWorkerHostNotReady If the driver could not start the host for a transient reason; the job should be retried.
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
	for (const settled of await expireLostComputerActions(deps, job.tenantId)) {
		if (settled.status === "done") await deps.resumeTurn(settled.tenantId, settled.turnId, settled.actionId);
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
		if (error instanceof OrganizationComputerNotSetUpError) {
			consoleLogEmitter({ tenant_id: job.tenantId, turn_id: job.turnId })("computer_start_refused", { reason_class: error.reasonClass });
			const turn = await deps.turns.store.getTurn(job.tenantId, job.turnId);
			if (turn !== null && turn.status === "active" && turn.waitingFor !== null) {
				await failStaleTurn(deps.turns, turn, "waiting", COMPUTER_NOT_SET_UP_REASON);
			}
			return { kind: "refused", reason: error.reasonClass };
		}
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
		const answered = await answerComputerActionOnOwnAccount(deps, action, { result: deniedActionResult(reason), isError: true });
		if (answered !== null) await deps.resumeTurn(job.tenantId, job.turnId, action.actionId);
	}
}
