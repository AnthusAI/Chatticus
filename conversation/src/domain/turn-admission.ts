import type { MailboxItem } from "../pi/mailbox.ts";

/** What one bot's active-turn pointer on one channel currently resolves to. */
export type OpenTurnState = {
	/** The turn the pointer names, which may be finished and awaiting replacement. */
	readonly pointerTurnId: string;
	/** Whether that turn is still running (status active). */
	readonly active: boolean;
	/** Whether the turn has begun finalizing and no longer accepts steered messages. */
	readonly closing: boolean;
};

/**
 * Everything needed to create the turn control record, its turn.started event, and the per-(channel, bot) and primary
 * pointers in one write.
 */
export type StartTurnRequest = {
	readonly tenantId: string;
	readonly channelId: string;
	readonly botId: string;
	readonly turnId: string;
	readonly promptMessageSeq: number;
	readonly createdAt: Date;
	/** Identifier of the turn.started event written with the record. */
	readonly startedEventId: string;
	/** The turn the pointer is expected to name now, or null when the pointer must not exist yet. */
	readonly expectedPointerTurnId: string | null;
};

/** Writing the turn control record and pointer, the part of turn handling that message admission needs. */
export interface TurnAdmission {
	/** The state of the turn behind a bot's pointer on a channel, or null when the bot has never had a turn there. */
	openTurn(tenantId: string, channelId: string, botId: string): Promise<OpenTurnState | null>;
	/**
	 * Create the turn record and point the bot at it, in one conditional write.
	 *
	 * @returns false when the pointer no longer names the expected turn, so the caller must look again.
	 */
	startTurn(request: StartTurnRequest): Promise<boolean>;
	/**
	 * Put a mailbox item for the turn's bot under the condition that the turn is still active and not closing.
	 *
	 * @returns false when that condition failed, so the caller must look again.
	 */
	steerTurn(turnId: string, item: MailboxItem): Promise<boolean>;
}

/** The job the front door hands the queue when a message starts a turn. */
export type TurnRunJob = {
	readonly tenantId: string;
	readonly channelId: string;
	readonly botId: string;
	readonly turnId: string;
	readonly requiredCapabilities: readonly string[];
};

/** Where run jobs for new turns are published. */
export interface TurnRunQueue {
	enqueue(job: TurnRunJob): Promise<void>;
}
