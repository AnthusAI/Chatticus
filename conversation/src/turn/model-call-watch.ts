/** What an attempt is waiting on, as far as the Pi events it has seen can tell. */
export type AttemptWaitSnapshot = {
	/** Whether a model request has been made and its answer has not finished arriving. */
	readonly modelRequestOutstanding: boolean;
	/** Whether a tool call is running, which the model deadline does not count against the model. */
	readonly toolRunning: boolean;
	/** Model requests made by this attempt. */
	readonly modelRequests: number;
	/** The type of the newest Pi event, or none when the attempt has seen no event. */
	readonly lastEventType: string | null;
	/** Milliseconds since the newest Pi event, or since the attempt started when it has seen none. */
	readonly silentMilliseconds: number;
	/** Whether the model has produced anything: streamed output, a tool call or a tool result. */
	readonly madeProgress: boolean;
};

const PROGRESS_EVENT_TYPES = new Set(["message_update", "tool_execution_start", "tool_execution_end"]);

/**
 * Follows the Pi events of one attempt so the executor can tell how long the model has been silent and say what the
 * attempt was waiting on when it hands a turn on or gives up on it.
 */
export class ModelCallWatch {
	private lastEventAtMilliseconds: number;
	private lastEventType: string | null = null;
	private modelRequestOutstanding = false;
	private runningTools = 0;
	private modelRequests = 0;
	private madeProgress = false;

	/** @param startedAtMilliseconds When the attempt started, the silence clock's origin. */
	constructor(startedAtMilliseconds: number) {
		this.lastEventAtMilliseconds = startedAtMilliseconds;
	}

	/** Record a batch of Pi events delivered at `nowMilliseconds`. */
	observe(events: readonly { readonly type: string }[], nowMilliseconds: number): void {
		for (const event of events) {
			this.lastEventAtMilliseconds = nowMilliseconds;
			this.lastEventType = event.type;
			if (PROGRESS_EVENT_TYPES.has(event.type)) this.madeProgress = true;
			switch (event.type) {
				case "turn_start":
					this.modelRequestOutstanding = true;
					this.modelRequests += 1;
					break;
				case "tool_execution_start":
					this.modelRequestOutstanding = false;
					this.runningTools += 1;
					break;
				case "tool_execution_end":
					this.runningTools = Math.max(0, this.runningTools - 1);
					break;
				case "turn_end":
				case "run_end":
					this.modelRequestOutstanding = false;
					break;
				default:
					break;
			}
		}
	}

	/** What the attempt is waiting on at `nowMilliseconds`. */
	snapshot(nowMilliseconds: number): AttemptWaitSnapshot {
		return {
			modelRequestOutstanding: this.modelRequestOutstanding,
			toolRunning: this.runningTools > 0,
			modelRequests: this.modelRequests,
			lastEventType: this.lastEventType,
			silentMilliseconds: Math.max(0, nowMilliseconds - this.lastEventAtMilliseconds),
			madeProgress: this.madeProgress,
		};
	}
}
