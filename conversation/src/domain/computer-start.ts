/**
 * Starting the organization's computer host for a parked turn.
 *
 * A turn that parks on a computer action while no live host serves its computer publishes a `ComputerStartJob`. The
 * starter (the old ComputerWorker without turn logic) consumes it: it refuses work the spend ceiling blocks, asks for a
 * host start under the computer's lease (one start per generation, however many jobs arrive), and calls the host start
 * driver once. It does not wait for the host: the host finds its work by claiming actions when it boots.
 *
 * Every ending of a job is either a start or a settled turn. A refusal retrying cannot cure fails the parked turn at
 * once; a failure retrying might cure is retried a bounded number of times and then fails the parked turn too.
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
import { consoleLogEmitter, errorNameOf } from "../observability/log-line.ts";
import { answerComputerActionOnOwnAccount, type ActionDependencies, expireLostComputerActions } from "./actions.ts";
import { type HostStartClaim, type HostStartDependencies, liveOwnerOfOrganization, requestComputerHostStart } from "./computers.ts";
import type { Organization } from "./organizations.ts";
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
	| { readonly kind: "already_serving"; readonly hostStartGeneration: number; readonly ownerId: string }
	| { readonly kind: "refused"; readonly reason: string }
	| { readonly kind: "gave_up"; readonly reason: string };

/** What the queue says about one delivery of a start job. */
export type ComputerStartDelivery = {
	/** How many times the queue has delivered the job, this delivery included (SQS `ApproximateReceiveCount`). */
	readonly receiveCount: number;
};

/**
 * How many deliveries a start job gets before the starter gives up on it. It is lower than the queue's own redrive limit,
 * so a job that keeps failing is ended here, with the parked turn told why, and never reaches the dead-letter queue.
 */
export const COMPUTER_START_MAX_DELIVERIES = 3;

/** What a person reads on a turn whose organization has no computer set up. */
export const COMPUTER_NOT_SET_UP_REASON =
	"This organization has no computer set up yet. Ask your Chatticus operator to set one up, then send your message again.";

/**
 * What a person reads on a turn whose organization is not enabled, so its computer will not start.
 *
 * @param status The organization status, or null when the organization record is gone.
 * @returns The plain-language reason.
 */
export const organizationNotEnabledReason = (status: Organization["status"] | null): string =>
	`This organization ${status === "suspended" ? "is suspended" : "is not enabled"}, so its computer will not start. Ask your Chatticus operator to enable it, then send your message again.`;

/** What a person reads on a turn whose computer could not be started within the retry budget. */
export const COMPUTER_START_GAVE_UP_REASON =
	"The computer for this organization could not be started after several tries. Please send your message again in a few minutes. If it keeps happening, ask your Chatticus operator to check the organization's computer setup.";

/** The result a turn reads for an action the spend ceiling stopped after it was parked. */
export const deniedActionResult = (reason: string): string => `denied: ${reason}`;

async function failParkedTurn(deps: ComputerStarterDependencies, job: ComputerStartJob, reason: string): Promise<void> {
	const turn = await deps.turns.store.getTurn(job.tenantId, job.turnId);
	if (turn !== null && turn.status === "active" && turn.waitingFor !== null) {
		await failStaleTurn(deps.turns, turn, "waiting", reason);
	}
}

/**
 * Handle one delivery of a start job. A failure that retrying can cure (ECS or STS failed, a customer stack is still
 * being created) is thrown so the queue redelivers the job, up to `COMPUTER_START_MAX_DELIVERIES` deliveries; the last
 * delivery fails the parked turn with a plain reason and ends the job. A refusal that retrying cannot cure (the
 * organization is not enabled, has no AWS home, or has no cross-account role) fails the parked turn at once and ends the
 * job. A refused spend ceiling answers the turn's open actions with a denial. Every ending but a retry leaves the job
 * done: never redelivered, never dead-lettered.
 *
 * @param deps Stores, clock, the host start driver and how to resume a turn.
 * @param job The start job.
 * @param delivery What the queue says about this delivery.
 * @returns How it ended.
 * @throws ComputerWorkerRequiresComputerCapability If the job does not need the computer capability.
 * @throws Error If the start failed for a transient reason and the job has deliveries left; the job should be retried.
 */
export async function handleComputerStartJob(
	deps: ComputerStarterDependencies,
	job: ComputerStartJob,
	delivery: ComputerStartDelivery,
): Promise<ComputerStartOutcome> {
	if (!job.requiredCapabilities.includes("computer")) {
		throw new ComputerWorkerRequiresComputerCapability(
			`Job ${JSON.stringify(job.jobId)} does not require the computer capability.`,
		);
	}
	try {
		return await attemptComputerStart(deps, job);
	} catch (error) {
		if (delivery.receiveCount < COMPUTER_START_MAX_DELIVERIES) throw error;
		consoleLogEmitter({ tenant_id: job.tenantId, turn_id: job.turnId })("computer_start_gave_up", {
			reason_class: "start_attempts_exhausted",
			deliveries: delivery.receiveCount,
			error_name: errorNameOf(error),
		});
		await failParkedTurn(deps, job, COMPUTER_START_GAVE_UP_REASON);
		return { kind: "gave_up", reason: "start_attempts_exhausted" };
	}
}

async function attemptComputerStart(deps: ComputerStarterDependencies, job: ComputerStartJob): Promise<ComputerStartOutcome> {
	for (const settled of await expireLostComputerActions(deps, job.tenantId)) {
		if (settled.status === "done") await deps.resumeTurn(settled.tenantId, settled.turnId, settled.actionId);
	}
	const liveOwner = await liveOwnerOfOrganization(job.tenantId, deps);
	if (liveOwner !== null) {
		consoleLogEmitter({ tenant_id: job.tenantId, turn_id: job.turnId })("computer_start_already_serving", {
			owner_id: liveOwner.ownerId,
			generation: liveOwner.computer.hostStartGeneration,
		});
		return { kind: "already_serving", hostStartGeneration: liveOwner.computer.hostStartGeneration, ownerId: liveOwner.ownerId };
	}
	const organization = await deps.store.getOrganization(job.tenantId);
	if (organization === null || organization.status !== "enabled") {
		consoleLogEmitter({ tenant_id: job.tenantId, turn_id: job.turnId })("computer_start_refused", { reason_class: "organization_not_enabled" });
		await failParkedTurn(deps, job, organizationNotEnabledReason(organization?.status ?? null));
		return { kind: "refused", reason: "organization_not_enabled" };
	}
	let claim: HostStartClaim;
	try {
		claim = await requestComputerHostStart(deps, job.tenantId, job.userId);
	} catch (error) {
		if (!(error instanceof OrganizationSpendCeilingExceededError)) throw error;
		await denyOpenActionsOfTurn(deps, job.tenantId, job.turnId, error.message);
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
			await failParkedTurn(deps, job, COMPUTER_NOT_SET_UP_REASON);
			return { kind: "refused", reason: error.reasonClass };
		}
		if (error instanceof OrganizationComputerProvisioningError) {
			throw new ComputerWorkerHostNotReady(`Turn ${JSON.stringify(job.turnId)} computer provisioning refused: ${error.message}`);
		}
		throw new ComputerWorkerHostNotReady(`Turn ${JSON.stringify(job.turnId)} host start failed: ${(error as Error).message}.`);
	}
	return { kind: "started", hostStartGeneration: claim.hostStartGeneration };
}

/**
 * Answer every open action of a turn as denied for `reason` and resume the turn for each, so a turn the spend ceiling
 * stopped ends visibly instead of waiting out its limit. Used by the starter and by the poll of a live owner.
 *
 * @param deps Action store, clock and how to resume a turn.
 * @param tenantId Organization.
 * @param turnId The turn whose open actions are denied.
 * @param reason The refusal a member can read.
 */
export async function denyOpenActionsOfTurn(
	deps: Pick<ComputerStarterDependencies, "actions" | "clock" | "resumeTurn">,
	tenantId: string,
	turnId: string,
	reason: string,
): Promise<void> {
	for (const action of await deps.actions.listForTurn(tenantId, turnId)) {
		if (action.status === "done") continue;
		const answered = await answerComputerActionOnOwnAccount(deps, action, { result: deniedActionResult(reason), isError: true });
		if (answered !== null) await deps.resumeTurn(tenantId, turnId, action.actionId);
	}
}
