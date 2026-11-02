import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type AgentEventStream,
	type Conversation,
	type SettledSubmissionRecord,
	type Submission,
	watchEvents,
} from "@earendil-works/pi-durable";
import {
	ATTEMPT_LEASE_SECONDS,
	beginClosing,
	claimTurn,
	completeTurn,
	failTurn,
	reconcileTurn,
	recordStorageFence,
	renewTurn,
	type Turn,
	type TurnClaim,
} from "../domain/turns.ts";
import { MemberStandingRequiredError, StaleAttemptError, TurnTerminalError } from "../http/errors.ts";
import { type ChannelMessageDraft, recordInputLine, writeAttributedMessage } from "../pi/channel-log.ts";
import { CommitOutcomeUnknown, findStorageFailure, OwnershipLost } from "../pi/errors.ts";
import { chatticusExtensions } from "../pi/extension.ts";
import { type ComputerToolCall, type ComputerToolHandoff, computerToolsExtension } from "../pi/computer-tools.ts";
import { type ToolGateDependencies, toolGateExtension } from "../pi/gate.ts";
import { botBoardToolExtensions } from "../pi/bot-board-tool.ts";
import { taskToolExtensions } from "../pi/task-tool.ts";
import { primaryHumanParticipant } from "../domain/channels.ts";
import { PolicyControl } from "../policy/policy-control.ts";
import { turnCapabilityGrant } from "../policy/turn-grant.ts";
import { DynamoPolicyStore } from "../store/policy-store.ts";
import { list as listMailbox, type MailboxItem, type MailboxStore, remove as removeMailboxItem } from "../pi/mailbox.ts";
import { type OwnerSession, openOwnerSession } from "../pi/session.ts";
import { storageIdFor } from "../storage/storage-support.ts";
import type { Bot } from "../store/codecs/bot.ts";
import type { Channel } from "../domain/channels.ts";
import { classifyModelFailure, summarizeProviderFailure } from "./classify-errors.ts";
import { formatLogLine } from "../observability/log-line.ts";
import { DEFAULT_TOKEN_FLUSH_BYTES, DEFAULT_TOKEN_FLUSH_MILLISECONDS, TokenCoalescer } from "./coalescer.ts";
import { AgentEventDelivery, createAgentEventListener, TurnEventWriter, writeToolCallOnce } from "./event-stream.ts";
import { redactSecrets } from "./tool-event-fields.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import { MESSAGE_BODY_INLINE_BYTES } from "../store/codecs/channel.ts";
import { requestPendingErasureCompletion } from "./after-turn-erasure.ts";
import { commitFinalAnswer, type FinalizeInputs, recordTurnCost } from "./finalize.ts";
import { ModelCallWatch } from "./model-call-watch.ts";
import { describePiEvents, describePiState } from "./pi-diagnostics.ts";
import { rebuildDroppedSession } from "./rebuild-dropped-session.ts";
import { armProbe } from "./probes.ts";
import { computerToolUnavailableText, computerWorkRefusal, type ParkDependencies, parkOnComputerAction } from "./park.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { DEFAULT_YIELD_BELOW_MILLISECONDS, yieldAttempt } from "./yield.ts";
import type { ExecutorDeps, ExecutorTuning, TurnExecutionJob, TurnExecutionOutcome } from "./types.ts";

/** The design's timing: renew every 20 seconds, look for steered messages twice a second, Pi retries twice. */
export const DEFAULT_EXECUTOR_TUNING: ExecutorTuning = {
	renewIntervalMilliseconds: 20_000,
	mailboxPollMilliseconds: 500,
	yieldBelowMilliseconds: DEFAULT_YIELD_BELOW_MILLISECONDS,
	modelCallDeadlineMilliseconds: 120_000,
	maximumFruitlessYields: 1,
	tokenFlushBytes: DEFAULT_TOKEN_FLUSH_BYTES,
	tokenFlushMilliseconds: DEFAULT_TOKEN_FLUSH_MILLISECONDS,
	retry: { maxRetries: 2, baseDelayMilliseconds: 1000 },
	compaction: { keepRecentTokens: 20_000 },
};

/** The longest the executor waits for Pi to deliver the events of the batch that settled the turn's last input. */
const EVENT_DELIVERY_WAIT_MILLISECONDS = 2000;

/** The text of a message whose mailbox item holds only a pointer, read from the channel record. */
async function recordBodyOf(messaging: Pick<MessagingStore, "listMessages">, item: MailboxItem): Promise<string> {
	const row = (await messaging.listMessages(item.tenantId, item.channelId, item.seq - 1)).find((message) => message.seq === item.seq);
	return row === undefined || row.deletedAt !== undefined ? "" : row.body;
}

/** The body the completion event of a turn carries: the reply, unless it is longer than a row holds, when listeners read the message instead. */
const completedEventBody = (body: string): string => (Buffer.byteLength(body, "utf8") > MESSAGE_BODY_INLINE_BYTES ? "" : body);

/** The reason shown when a turn's prompt message cannot be found in the mailbox or the session. */
export const MISSING_PROMPT_REASON = "The message this turn was meant to answer is missing.";

/** The reason shown when the bot or channel of a turn no longer exists. */
export const MISSING_SUBJECT_REASON = "The bot or the channel of this turn no longer exists.";

/** The reason shown when the model provider accepted a request and then went silent past the deadline. */
export const MODEL_CALL_DEADLINE_REASON = "The model provider did not answer in time, so the turn was stopped.";

/** The reason shown when a turn handed itself on repeatedly without producing anything. */
export const NO_PROGRESS_REASON = "The turn handed itself on without making progress, so it was stopped.";

/** Milliseconds the executor gives Pi to withdraw an unanswered input and to close, so a model call that never returns cannot hold the function. */
const ABORT_WAIT_MILLISECONDS = 2000;

/** The reason on turn.reconciling when a Pi commit's outcome is unknown. */
export const UNCERTAIN_COMMIT_REASON = "The conversation could not confirm its last write; the turn is being reconciled.";

/** The reason the parked tool's invocation is rejected with when its owner closes to hand the turn to the computer. */
const OWNER_CLOSED_FOR_HANDOFF = "The owner closed to hand the turn to the computer.";

class AttemptLost extends Error {
	constructor() {
		super("Another attempt now owns this turn.");
		this.name = "AttemptLost";
	}
}

type TrackedInput = {
	readonly requestId: string;
	readonly isPrompt: boolean;
	readonly item: MailboxItem | null;
	readonly submission: Submission;
	recorded: boolean;
	settled: SettledSubmissionRecord | null;
	watching: Promise<void>;
};

const draftOf = (item: MailboxItem): Omit<ChannelMessageDraft, "body"> => ({
	seq: item.seq,
	messageId: item.messageId,
	authorKind: item.authorKind,
	authorId: item.authorId,
	addressedToBotId: item.addressedToBotId,
	createdAt: item.createdAt,
	...(item.origin === undefined ? {} : { origin: item.origin }),
});

const delay = (milliseconds: number): { promise: Promise<void>; cancel: () => void } => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const promise = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, milliseconds);
	});
	return { promise, cancel: () => clearTimeout(timer) };
};

/** One attempt at one turn: it owns the turn record, the bot's Pi session and the turn's events until it ends. */
class TurnAttempt {
	private readonly job: TurnExecutionJob;
	private readonly deps: ExecutorDeps;
	private readonly tuning: ExecutorTuning;
	private readonly attemptId: string;
	private readonly turn: Turn;
	private readonly context;
	private readonly mailbox: MailboxStore;
	private readonly writer: TurnEventWriter;
	private readonly coalescer: TokenCoalescer;
	private readonly thinkingCoalescer: TokenCoalescer;
	private readonly delivery = new AgentEventDelivery();
	private readonly inputs: TrackedInput[] = [];
	private readonly lost: Promise<never>;
	private signalLost: () => void = () => undefined;
	private renewTimer: ReturnType<typeof setInterval> | null = null;
	private renewing = false;
	private fatal: unknown = null;
	private parkCall: ComputerToolCall | null = null;
	private readonly parkRequested: Promise<void>;
	private signalPark: () => void = () => undefined;
	private session: OwnerSession | null = null;
	private root: Conversation | null = null;
	private stream: AgentEventStream | null = null;
	private bot: Bot | null = null;
	private channel: Channel | null = null;
	private readonly modelWatch: ModelCallWatch;

	constructor(job: TurnExecutionJob, deps: ExecutorDeps, tuning: ExecutorTuning, attemptId: string, turn: Turn) {
		this.job = job;
		this.deps = deps;
		this.tuning = tuning;
		this.attemptId = attemptId;
		this.turn = turn;
		this.context = deps.context ?? BACKGROUND_CONTEXT;
		this.modelWatch = new ModelCallWatch(Date.now());
		this.mailbox = { client: deps.client, tableName: deps.messagingTableName };
		this.writer = new TurnEventWriter(deps.turns, job.tenantId, job.turnId, attemptId);
		this.coalescer = new TokenCoalescer({
			flushBytes: tuning.tokenFlushBytes,
			flushMilliseconds: tuning.tokenFlushMilliseconds,
			write: async (text) => {
				deps.faults?.maybeCrash("progress_append", "before");
				await this.writer.write({ kind: "turn.token", token: text });
				deps.faults?.maybeCrash("progress_append", "after");
			},
		});
		this.thinkingCoalescer = new TokenCoalescer({
			flushBytes: tuning.tokenFlushBytes,
			flushMilliseconds: tuning.tokenFlushMilliseconds,
			write: async (text) => {
				await this.writer.write({ kind: "turn.thinking", text: redactSecrets(text) });
			},
		});
		this.lost = new Promise<never>((_resolve, reject) => {
			this.signalLost = () => reject(new AttemptLost());
		});
		this.lost.catch(() => undefined);
		this.parkRequested = new Promise<void>((resolve) => {
			this.signalPark = resolve;
		});
	}

	async run(): Promise<TurnExecutionOutcome> {
		try {
			return await this.execute();
		} catch (error) {
			return await this.settleError(error);
		} finally {
			await this.cleanup();
		}
	}

	private async execute(): Promise<TurnExecutionOutcome> {
		const { messaging } = this.deps;
		const bot = await messaging.getBot(this.job.tenantId, this.job.botId);
		const channel = await messaging.getChannel(this.job.tenantId, this.turn.channelId);
		if (bot === null || channel === null) return this.fail(MISSING_SUBJECT_REASON);
		const { prices } = this.deps.ledger;
		if (prices.lookup(this.deps.model.provider, this.deps.model.modelId) === null) {
			return this.fail(
				`No price is tabled for model ${this.deps.model.provider}/${this.deps.model.modelId} in price book ${prices.priceBookId}, so the turn was not run.`,
			);
		}
		this.bot = bot;
		this.channel = channel;
		const sessionDependencies = {
			client: this.deps.client,
			s3: this.deps.s3,
			tableName: this.deps.conversationsTableName,
			bucket: this.deps.piSessionsBucket,
			models: this.deps.models,
			extensions: this.deps.executionProfile === "computerless"
				? chatticusExtensions({ systemPrompt: () => buildSystemPrompt({ botName: bot.name, memory: bot.memory }) })
				: [
				...chatticusExtensions({
					systemPrompt: () => buildSystemPrompt({ botName: bot.name, memory: bot.memory }),
				}),
				...taskToolExtensions(
					{ tenantId: this.job.tenantId, userId: primaryHumanParticipant(channel), botId: this.job.botId },
					{ store: messaging, ids: this.deps.turns.ids },
				),
				...(this.deps.boards === undefined
					? []
					: botBoardToolExtensions(
							{ organizationId: this.job.tenantId, botId: this.job.botId, turnId: this.job.turnId },
							this.deps.boards,
						)),
				(this.deps.computerTools ?? computerToolsExtension)(this.computerHandoff()),
				toolGateExtension(this.toolGateDependencies()),
			],
			context: this.context,
			env: this.deps.env,
			settings: {
				retry: { maxRetries: this.tuning.retry.maxRetries, baseDelayMs: this.tuning.retry.baseDelayMilliseconds },
				compaction: { keepRecentTokens: this.tuning.compaction.keepRecentTokens },
			},
		};
		const session = await (this.deps.sessionFactory ?? openOwnerSession)(
			storageIdFor(this.job.tenantId, this.job.botId, this.turn.channelId),
			sessionDependencies,
		);
		this.session = session;
		await recordStorageFence(this.deps.turns, this.job.tenantId, this.job.turnId, this.attemptId, session.fence);
		await this.readJournal();
		await this.writer.write({ kind: "attempt.claimed", attemptId: this.attemptId });
		if (this.delivery.computerStarting) {
			this.delivery.setComputerStartingOutstanding(false);
			await this.writer.write({ kind: "computer.ready", detail: "Computer ready" });
		}
		this.writer.throwIfFailed();
		const agent = {
			model: { provider: this.deps.model.provider, modelId: this.deps.model.modelId },
			thinkingLevel: this.deps.model.thinkingLevel,
		};
		const root = await session.harness.root(this.context, { agent });
		this.root = root;
		await root.configure(agent, this.context);
		await rebuildDroppedSession(this.deps, session, this.job.tenantId, this.job.botId, this.turn.channelId, this.context);
		this.stream = await watchEvents(session.harness, root.id, this.context);
		const forwardEvents = createAgentEventListener(this.writer, this.coalescer, this.thinkingCoalescer, this.attemptId, this.delivery);
		this.stream.start(async (events) => {
			this.modelWatch.observe(events, Date.now());
			const batch = describePiEvents(events);
			if (batch !== null) console.info(formatLogLine("pi_events", { turn_id: this.job.turnId, attempt: this.turn.attempt, ...batch }));
			await forwardEvents(events);
		});
		this.renewTimer = setInterval(() => void this.renew(), this.tuning.renewIntervalMilliseconds);
		return this.drive(session, root);
	}

	private async drive(session: OwnerSession, root: Conversation): Promise<TurnExecutionOutcome> {
		if (this.turn.attempt > 1) await recordTurnCost(this.finalizeInputs(session, root), "resumed");
		this.deps.faults?.maybeCrash("model_acceptance", "before");
		await this.pumpMailbox(session, root);
		if (!this.inputs.some((input) => input.isPrompt)) {
			await this.adoptSubmittedPrompt(root);
		}
		if (!this.inputs.some((input) => input.isPrompt)) return this.fail(MISSING_PROMPT_REASON);
		let closing = false;
		for (;;) {
			await this.waitForProgress();
			await this.guard(session);
			if (this.parkCall !== null) return this.parkOnComputer(this.parkCall);
			if (this.modelCallExpired()) return this.failExpiredModelCall(root);
			if (this.mustYield()) return this.yieldTurn();
			await this.pumpMailbox(session, root);
			if (this.inputs.some((input) => input.settled === null)) {
				if (this.endedRun() !== undefined) await this.withdrawQueuedInputs(root);
				continue;
			}
			if (!closing) {
				await beginClosing(this.deps.turns, this.job.tenantId, this.job.turnId, this.attemptId);
				closing = true;
				await this.pumpMailbox(session, root);
				if (this.inputs.some((input) => input.settled === null)) continue;
			}
			break;
		}
		return this.conclude(session, root);
	}

	/** The input whose run ended without an answer (model error, fault, no model): Pi starts nothing after it. */
	private endedRun(): TrackedInput | undefined {
		return this.inputs.find((input) => input.settled?.status === "unanswered" && input.settled.reason !== "aborted");
	}

	/** A run that ends unanswered does not place the inputs queued behind it, so withdraw them and let the turn report the failure. */
	private async withdrawQueuedInputs(root: Conversation): Promise<void> {
		console.info(formatLogLine("queued_inputs_withdrawn", { turn_id: this.job.turnId, attempt: this.turn.attempt, unsettled_inputs: this.inputs.filter((input) => input.settled === null).length }));
		await root.abort(this.context);
	}

	private async conclude(session: OwnerSession, root: Conversation): Promise<TurnExecutionOutcome> {
		const concluding = this.endedRun() ?? this.inputs[this.inputs.length - 1]!;
		await this.delivery.untilSettled(concluding.submission.id as number, EVENT_DELIVERY_WAIT_MILLISECONDS);
		this.deps.faults?.maybeCrash("model_acceptance", "after");
		await this.flushStreams();
		await this.guard(session);
		if (!(await renewAttempt(this.deps, this.job.tenantId, this.job.turnId, this.attemptId))) {
			throw new AttemptLost();
		}
		const last = concluding.settled!;
		if (last.type !== "input" || last.status !== "done") {
			if (last.status === "unanswered" && last.reason === "model_error") {
				const { status, code, message } = summarizeProviderFailure(last.detail);
				console.info(formatLogLine("provider_failed", { turn_id: this.job.turnId, status, code, message }));
				return this.fail(classifyModelFailure(last.detail));
			}
			return this.fail(`The turn was not answered (${last.status === "unanswered" ? last.reason : last.status}).`);
		}
		const inputs = this.finalizeInputs(session, root);
		this.deps.faults?.maybeCrash("completion_append", "before");
		const reply = await commitFinalAnswer(inputs, last.answer);
		await recordTurnCost(inputs, "completed", reply.messageSeq);
		this.deps.faults?.maybeCrash("completion_append", "after");
		await completeTurn(this.deps.turns, this.job.tenantId, this.job.turnId, this.attemptId, reply.messageSeq, completedEventBody(reply.body));
		await requestPendingErasureCompletion(this.deps, this.job.tenantId, this.turn.channelId);
		return "done";
	}

	private toolGateDependencies(): ToolGateDependencies {
		const policy = new PolicyControl({
			policyStore: new DynamoPolicyStore(this.deps.client, this.deps.messagingTableName),
			store: this.deps.messaging,
			clock: this.deps.turns.clock,
			ids: this.deps.turns.ids,
		});
		const { tenantId, turnId } = this.job;
		const promptAuthorId = this.turn.promptAuthorId;
		return {
			now: () => this.deps.turns.clock.now(),
			readGrant: () => turnCapabilityGrant(this.deps, tenantId, turnId),
			resolveStanding: (actionType) => {
				if (promptAuthorId === null) {
					throw new MemberStandingRequiredError(`Turn '${turnId}' has no prompt message.`);
				}
				return policy.memberStandingForUser(tenantId, promptAuthorId, actionType);
			},
		};
	}

	private parkDependencies(): ParkDependencies {
		const computer = this.deps.computer;
		if (computer === undefined) throw new Error("Computer handoff is unavailable for this execution profile.");
		return {
			turns: this.deps.turns,
			messaging: this.deps.messaging,
			turnRuns: this.deps.turnRuns,
			turnProbes: this.deps.turnProbes,
			computer,
			faults: this.deps.faults,
		};
	}

	private computerHandoff(): ComputerToolHandoff {
		if (this.deps.computer === undefined) throw new Error("Computer handoff is unavailable for this execution profile.");
		const { tenantId, turnId } = this.job;
		return {
			lookup: (call) => this.deps.computer.actions.getByCall(tenantId, turnId, call.callId),
			refusal: () => computerWorkRefusal(this.parkDependencies(), tenantId),
			unavailable: (call) => computerToolUnavailableText(this.parkDependencies(), tenantId, call),
			park: (call, abortSignal) => {
				this.parkCall ??= call;
				this.signalPark();
				return new Promise<never>((_resolve, reject) => {
					if (abortSignal?.aborted) reject(new Error(OWNER_CLOSED_FOR_HANDOFF));
					abortSignal?.addEventListener("abort", () => reject(new Error(OWNER_CLOSED_FOR_HANDOFF)));
				});
			},
		};
	}

	/**
	 * A resumed owner rereads the journal so the tool calls its predecessor already wrote are not written again when Pi
	 * reports them once more, the reasoning summary already written counts against the turn's cap, and a
	 * `computer.starting` that no `computer.ready` has answered is answered by this owner's claim.
	 */
	private async readJournal(): Promise<void> {
		if (this.turn.attempt <= 1) return;
		let starting = false;
		for (const event of await this.deps.turns.store.listEvents(this.job.tenantId, this.job.turnId, 0)) {
			if (event.kind === "tool.call" && event.callId !== undefined) {
				this.delivery.claimCallJournal(event.callId);
				const bytes = event.toolArguments?.["bytes"];
				this.delivery.rememberCall(event.callId, { toolName: event.tool ?? "", writtenBytes: typeof bytes === "number" ? bytes : null });
			} else if (event.kind === "turn.thinking") {
				this.delivery.addThinkingCharacters((event.text ?? "").length);
			} else if (event.kind === "computer.starting") {
				starting = true;
			} else if (event.kind === "computer.ready") {
				starting = false;
			}
		}
		this.delivery.setComputerStartingOutstanding(starting);
	}

	/**
	 * The turn called a computer tool that has no answer yet: record the action, park the turn and end this owner. The
	 * harness is closed without aborting (the session's close), so the tool call stays pending for the next owner.
	 */
	private async parkOnComputer(call: ComputerToolCall): Promise<TurnExecutionOutcome> {
		await this.flushStreams();
		await writeToolCallOnce(this.writer, this.delivery, call.callId, call.toolName, call.arguments);
		if (!this.delivery.computerStarting) {
			this.delivery.setComputerStartingOutstanding(true);
			await this.writer.write({ kind: "computer.starting", detail: "Starting your computer" });
		}
		await this.writer.idle();
		this.writer.throwIfFailed();
		await recordTurnCost(this.finalizeInputs(this.session!, this.root!), "parked");
		await parkOnComputerAction(this.parkDependencies(), this.turn, this.attemptId, call);
		return "parked";
	}

	private async flushStreams(): Promise<void> {
		await this.thinkingCoalescer.flush();
		await this.coalescer.flush();
	}

	private mustYield(): boolean {
		const remaining = this.deps.remainingMilliseconds;
		if (remaining === undefined || remaining() >= this.tuning.yieldBelowMilliseconds) return false;
		return this.inputs.some((input) => input.settled === null);
	}

	private modelCallExpired(): boolean {
		if (!this.inputs.some((input) => input.settled === null)) return false;
		const waiting = this.modelWatch.snapshot(Date.now());
		return !waiting.toolRunning && waiting.silentMilliseconds >= this.tuning.modelCallDeadlineMilliseconds;
	}

	private waitFields(): Record<string, string | number | boolean | null> {
		const waiting = this.modelWatch.snapshot(Date.now());
		return {
			turn_id: this.job.turnId,
			attempt: this.turn.attempt,
			unsettled_inputs: this.inputs.filter((input) => input.settled === null).length,
			model_request_outstanding: waiting.modelRequestOutstanding,
			model_requests: waiting.modelRequests,
			tool_running: waiting.toolRunning,
			last_event: waiting.lastEventType,
			silent_ms: waiting.silentMilliseconds,
			made_progress: waiting.madeProgress,
		};
	}

	private async logPiState(): Promise<void> {
		try {
			console.info(formatLogLine("pi_state", { turn_id: this.job.turnId, attempt: this.turn.attempt, ...(await describePiState(this.session!.harness, this.context)) }));
		} catch (error) {
			console.info(formatLogLine("pi_state_unreadable", { turn_id: this.job.turnId, error: error instanceof Error ? error.name : "unknown" }));
		}
	}

	private async failExpiredModelCall(root: Conversation): Promise<TurnExecutionOutcome> {
		await this.logPiState();
		console.info(formatLogLine("model_call_deadline_exceeded", { ...this.waitFields(), deadline_ms: this.tuning.modelCallDeadlineMilliseconds }));
		const withdrawn = delay(ABORT_WAIT_MILLISECONDS);
		await Promise.race([root.abort(this.context).catch(() => undefined), withdrawn.promise]);
		withdrawn.cancel();
		await this.flushStreams();
		this.writer.throwIfFailed();
		const cost = recordTurnCost(this.finalizeInputs(this.session!, root), "failed").catch(() => undefined);
		const costWait = delay(ABORT_WAIT_MILLISECONDS);
		await Promise.race([cost, costWait.promise]);
		costWait.cancel();
		await failTurn(this.deps.turns, this.job.tenantId, this.job.turnId, this.attemptId, MODEL_CALL_DEADLINE_REASON);
		return "failed";
	}

	private async fruitlessYieldsSoFar(): Promise<number> {
		let count = 0;
		for (const event of await this.deps.turns.store.listEvents(this.job.tenantId, this.job.turnId, 0)) {
			if (event.kind === "attempt.relinquished") count += 1;
			else if (["turn.token", "turn.thinking", "tool.call", "tool.result"].includes(event.kind)) count = 0;
		}
		return count;
	}

	private async yieldTurn(): Promise<TurnExecutionOutcome> {
		const waiting = this.modelWatch.snapshot(Date.now());
		const fields = { ...this.waitFields(), remaining_ms: this.deps.remainingMilliseconds?.() };
		if (!waiting.madeProgress && (await this.fruitlessYieldsSoFar()) >= this.tuning.maximumFruitlessYields) {
			console.info(formatLogLine("turn_yield_refused", { ...fields, maximum_fruitless_yields: this.tuning.maximumFruitlessYields }));
			return this.fail(NO_PROGRESS_REASON);
		}
		console.info(formatLogLine("turn_yielded", fields));
		await this.logPiState();
		await this.flushStreams();
		this.writer.throwIfFailed();
		await recordTurnCost(this.finalizeInputs(this.session!, this.root!), "yielded");
		await yieldAttempt(this.deps, this.job.tenantId, this.job.turnId, this.attemptId);
		return "yielded";
	}

	private async fail(reason: string): Promise<TurnExecutionOutcome> {
		await this.flushStreams();
		this.writer.throwIfFailed();
		if (this.session !== null && this.root !== null) {
			await recordTurnCost(this.finalizeInputs(this.session, this.root), "failed");
		}
		await failTurn(this.deps.turns, this.job.tenantId, this.job.turnId, this.attemptId, reason);
		await requestPendingErasureCompletion(this.deps, this.job.tenantId, this.turn.channelId);
		return "failed";
	}

	private finalizeInputs(session: OwnerSession, root: Conversation): FinalizeInputs {
		return {
			deps: this.deps,
			turn: this.turn,
			attemptId: this.attemptId,
			bot: this.bot!,
			channel: this.channel!,
			session,
			root,
			context: this.context,
		};
	}

	private async settleError(thrown: unknown): Promise<TurnExecutionOutcome> {
		const error = findStorageFailure(thrown) ?? thrown;
		if (error instanceof CommitOutcomeUnknown) {
			try {
				await reconcileTurn(this.deps.turns, this.job.tenantId, this.job.turnId, this.attemptId, UNCERTAIN_COMMIT_REASON);
			} catch (inner) {
				if (inner instanceof StaleAttemptError || inner instanceof TurnTerminalError) {
					this.deps.observer?.lost?.("running");
					return "lost";
				}
				throw inner;
			}
			return "reconciling";
		}
		if (
			error instanceof AttemptLost ||
			error instanceof OwnershipLost ||
			error instanceof StaleAttemptError ||
			error instanceof TurnTerminalError
		) {
			this.deps.observer?.lost?.("running");
			return "lost";
		}
		throw error;
	}

	private async cleanup(): Promise<void> {
		if (this.renewTimer !== null) clearInterval(this.renewTimer);
		const closing = delay(ABORT_WAIT_MILLISECONDS);
		await Promise.race([
			(async () => {
				await this.stream?.stop().catch(() => undefined);
				await this.session?.close().catch(() => undefined);
			})(),
			closing.promise,
		]);
		closing.cancel();
	}

	private async guard(session: OwnerSession): Promise<void> {
		if (this.fatal !== null) throw this.fatal;
		this.writer.throwIfFailed();
		await session.harness.commit(() => undefined, this.context);
	}

	private async waitForProgress(): Promise<void> {
		const pause = delay(this.tuning.mailboxPollMilliseconds);
		const waits = this.inputs.filter((input) => input.settled === null).map((input) => input.watching);
		try {
			await Promise.race([this.lost, this.parkRequested, pause.promise, ...waits]);
		} finally {
			pause.cancel();
		}
	}

	private async renew(): Promise<void> {
		if (this.renewing) return;
		this.renewing = true;
		try {
			if (!(await renewAttempt(this.deps, this.job.tenantId, this.job.turnId, this.attemptId))) {
				this.signalLost();
			}
		} catch {
			return;
		} finally {
			this.renewing = false;
		}
	}

	private track(requestId: string, isPrompt: boolean, item: MailboxItem | null, submission: Submission): void {
		const input: TrackedInput = {
			requestId,
			isPrompt,
			item,
			submission,
			recorded: item === null,
			settled: null,
			watching: Promise.resolve(),
		};
		input.watching = submission.wait(this.context).then(
			(record) => {
				input.settled = record;
			},
			(error: unknown) => {
				this.fatal ??= error;
			},
		);
		this.inputs.push(input);
	}

	private async adoptSubmittedPrompt(root: Conversation): Promise<void> {
		const requestId = `turn:${this.job.turnId}`;
		const existing = await root.commit((tx) => tx.submissionByRequest(root.id, requestId), this.context);
		if (existing === undefined) return;
		const submission = await root.submit({ type: "input", content: "", requestId }, this.context);
		this.track(requestId, true, null, submission);
	}

	private async recordPending(session: OwnerSession): Promise<void> {
		for (const input of this.inputs) {
			if (input.recorded || input.item === null) continue;
			const state = await recordInputLine(session.harness, draftOf(input.item), input.requestId, this.context);
			if (state === "pending") continue;
			await removeMailboxItem(this.mailbox, input.item);
			input.recorded = true;
		}
	}

	private async pumpMailbox(session: OwnerSession, root: Conversation): Promise<void> {
		await this.recordPending(session);
		const tracked = new Set(this.inputs.map((input) => input.item?.messageId));
		const items = await listMailbox(this.mailbox, this.job.tenantId, this.job.botId, this.turn.channelId);
		for (const item of items) {
			if (tracked.has(item.messageId)) continue;
			const isPrompt = item.seq === this.turn.promptMessageSeq;
			const body = item.bodyInRecord === true ? await recordBodyOf(this.deps.messaging, item) : item.body;
			if (isPrompt || item.addressedToBotId === this.job.botId) {
				const requestId = isPrompt ? `turn:${this.job.turnId}` : `msg:${item.messageId}`;
				const submission = await root.submit(
					isPrompt
						? { type: "input", content: body, requestId }
						: { type: "input", content: body, requestId, whenBusy: "steer" },
					this.context,
				);
				this.track(requestId, isPrompt, item, submission);
				tracked.add(item.messageId);
			} else if (this.inputs.every((input) => input.settled !== null)) {
				await writeAttributedMessage(session.harness, { ...draftOf(item), body }, this.context);
				await removeMailboxItem(this.mailbox, item);
			}
		}
		await this.recordPending(session);
	}
}

/**
 * Extend the attempt's lease and deadline and keep its run job invisible to other consumers.
 *
 * @param deps Turn store and run-queue visibility.
 * @param tenantId Organization.
 * @param turnId Turn.
 * @param attemptId The attempt that owns the turn.
 * @returns false when the attempt no longer owns the turn, which means its owner is stale and must stop.
 */
export async function renewAttempt(
	deps: Pick<ExecutorDeps, "turns" | "runVisibility">,
	tenantId: string,
	turnId: string,
	attemptId: string,
): Promise<boolean> {
	if ((await renewTurn(deps.turns, tenantId, turnId, attemptId)) === null) return false;
	await deps.runVisibility.extend(tenantId, turnId);
	return true;
}

/**
 * Become the owner of a queued turn: take the compare-and-set claim, and arm the probe that notices if this owner
 * vanishes. The probe is armed before the claim can be lost to a crash.
 *
 * @param deps Stores, queues and fault hooks.
 * @param job The queue message.
 * @returns The claim, or null when a live owner exists or the turn cannot be claimed.
 */
export async function claimTurnAttempt(
	deps: Pick<ExecutorDeps, "turns" | "turnProbes" | "faults" | "workerLabel">,
	job: TurnExecutionJob,
): Promise<TurnClaim | null> {
	deps.faults?.maybeCrash("worker_claim", "before");
	const attemptId = deps.turns.ids.next();
	const claim = await claimTurn(deps.turns, job.tenantId, job.turnId, attemptId, deps.workerLabel ?? null);
	if (claim === null) return null;
	await armProbe(deps.turnProbes, claim.turn, ATTEMPT_LEASE_SECONDS);
	deps.faults?.maybeCrash("worker_claim", "after");
	return claim;
}

/**
 * Run one queued turn to its end: claim it, take the Pi storage fence, open the bot's session, bring the session up to
 * the channel from the mailbox, run the model with Pi, forward Pi's events as coalesced turn events, steer messages
 * posted to the same bot while it works, and finish. A finished turn commits only the final assistant text to the
 * channel at the next sequence, records the cost of its model calls in the session and on the ledger and completes; a failed model call fails the
 * turn with a reason the member can read. Whatever happens, the attempt writes nothing once another attempt owns the
 * turn.
 *
 * @param job The queue message.
 * @param deps Stores, clients, the model and timing.
 * @returns How the execution ended.
 * @throws Error For infrastructure failures that leave the turn active for the queue to retry.
 */
export async function executeTurn(job: TurnExecutionJob, deps: ExecutorDeps): Promise<TurnExecutionOutcome> {
	const tuning: ExecutorTuning = { ...DEFAULT_EXECUTOR_TUNING, ...deps.tuning };
	const claim = await claimTurnAttempt(deps, job);
	if (claim === null) {
		deps.observer?.lost?.("claim");
		return "lost";
	}
	deps.observer?.claimed?.(claim.attemptId, claim.turn.attempt);
	return new TurnAttempt(job, deps, tuning, claim.attemptId, claim.turn).run();
}

/**
 * Run one queue message the way its consumer does: execute the turn, then acknowledge the message. A failure before the
 * acknowledgement leaves the message on the queue, so it is delivered again.
 *
 * @param job The queue message.
 * @param deps Stores, clients, the model and timing.
 * @param acknowledge Deletes the message from the queue.
 * @returns How the execution ended.
 */
export async function consumeRunJob(
	job: TurnExecutionJob,
	deps: ExecutorDeps,
	acknowledge: () => Promise<void>,
): Promise<TurnExecutionOutcome> {
	const outcome = await executeTurn(job, deps);
	deps.faults?.maybeCrash("acknowledgement", "before");
	await acknowledge();
	deps.faults?.maybeCrash("acknowledgement", "after");
	return outcome;
}
