import {
	KanbusApiError,
	type BoardClient,
	type KanbusBoardIssueEntry,
	type KanbusFetch,
	type KanbusIssueFields,
	type KanbusIssuePatch,
	type KanbusIssueQuery,
	type KanbusIssueWithRevision,
} from "@kanbus/api-client";
import { deriveBoardOperationId } from "./board-operation-id.ts";
import { failureFromError, type BoardFailure, type BoardResult } from "./board-failures.ts";
import { createBoardClientForActor } from "./kanbus-board-client.ts";

/** Whose board: the organization is the Kanbus tenant and the bot is the Kanbus project. */
export type BoardAddress = { readonly organizationId: string; readonly botId: string };

/** Who is acting. A bot acts on its own board only; a user acts as a member, or as an owner when the role says so. */
export type BoardActor = { readonly kind: "bot"; readonly botId: string } | { readonly kind: "user"; readonly userId: string };

/** The part of the membership store the board rules read: the role, at every request. */
export type BoardMembershipReader = {
	getMembership(tenantId: string, userId: string): Promise<{ readonly role: string } | null>;
};

/** What the board service needs. */
export type BotBoardServiceDependencies = {
	readonly baseUrl: string;
	/** The fetch that signs and sends each request; see `createSigV4SignedFetch`. */
	readonly fetch: KanbusFetch;
	readonly memberships: BoardMembershipReader;
};

/** The fields of a new card. Everything but the title is optional; the board's own configuration fills the rest. */
export type NewCardFields = {
	readonly title: string;
	readonly type?: string;
	readonly description?: string;
	readonly priority?: number;
	readonly labels?: readonly string[];
	readonly parent?: string;
	readonly status?: string;
};

/** The fields of a card an update may change. */
export type CardChanges = {
	readonly title?: string;
	readonly description?: string;
	readonly priority?: number;
	readonly labels?: readonly string[];
	readonly status?: string;
};

/** How a dependency relates the card to its target, as Kanbus names the types. */
export type DependencyType = "blocked-by" | "relates-to";

/** Names one intended change so that a retry of it replays instead of repeating. */
export type WriteContext = {
	/** Identifies the intended change within the board; the same key and action always derive the same operation id. */
	readonly operationKey: string;
	/** The revision the writer saw. When absent the service reads the card and writes against the revision it read. */
	readonly revision?: string;
};

/** A page of cards. */
export type CardListing = { readonly cards: readonly KanbusBoardIssueEntry[]; readonly nextCursor: string | null };

/** The actor header value Kanbus records for an actor. */
export function actorHeaderFor(actor: BoardActor): string {
	return actor.kind === "bot" ? `chatticus:bot:${actor.botId}` : `chatticus:user:${actor.userId}`;
}

const DEFAULT_CARD_TYPE = "task";
const COMPLETED_CLOSING = "completed";
const ABANDONED_CLOSING = "abandoned";
const OWNER_ROLE = "owner";

type Access = "read" | "write" | "delete";

function refusal(message: string, code: string): BoardResult<never> {
	return { ok: false, failure: { kind: "refused", message, code } };
}

function failed(failure: BoardFailure): BoardResult<never> {
	return { ok: false, failure };
}

function saved<Value>(value: Value, listingMayBeBehind = false): BoardResult<Value> {
	return { ok: true, value, listingMayBeBehind };
}

function isBlank(text: string | undefined): boolean {
	return text === undefined || text.trim() === "";
}

/**
 * A bot's own work board, kept in the Kanbus board service. Chatticus adds only its own rules: who may act, and the
 * evidence or reason a card needs before it closes. Everything else (ids, workflow, hierarchy, required fields, closing
 * times) is Kanbus's, and a refusal from Kanbus is reported as it came.
 *
 * Every method returns a result. A write is reported as saved only after the store confirmed it, and as failed when the
 * store did not answer or answered with an error; it is never presented as done on a guess.
 */
export class BotBoardService {
	private readonly dependencies: BotBoardServiceDependencies;

	constructor(dependencies: BotBoardServiceDependencies) {
		this.dependencies = dependencies;
	}

	/**
	 * Provision the board of a new bot with Kanbus's default configuration. An empty-bodied configuration write is the
	 * whole request; Chatticus supplies no status list. A board that already exists counts as provisioned, so a retry is
	 * harmless. Needs the provision grant, which only the front door's role has.
	 */
	async provisionBotBoard(address: BoardAddress, actor: BoardActor): Promise<BoardResult<{ readonly created: boolean }>> {
		const operationId = deriveBoardOperationId(["provision", address.organizationId, address.botId]);
		try {
			await this.boardFor(address, actor).provision({ operationId });
			return saved({ created: true });
		} catch (error) {
			if (error instanceof KanbusApiError && error.code === "board_exists") return saved({ created: false });
			return failed(failureFromError(error));
		}
	}

	/** Archive the board of a deleted bot: it stops being listed or writable, and Kanbus purges it after its retention. Owner or system only. */
	async archiveBotBoard(address: BoardAddress, actor: BoardActor, operationKey: string): Promise<BoardResult<Record<string, unknown>>> {
		return this.lifecycle(address, actor, "archive", operationKey);
	}

	/** Restore an archived board within the retention period. Needs the provision grant and an owner. */
	async restoreBotBoard(address: BoardAddress, actor: BoardActor, operationKey: string): Promise<BoardResult<Record<string, unknown>>> {
		return this.lifecycle(address, actor, "restore", operationKey);
	}

	/** List the cards of a board. */
	async listCards(address: BoardAddress, actor: BoardActor, query: KanbusIssueQuery = {}): Promise<BoardResult<CardListing>> {
		const denied = await this.authorize(address, actor, "read");
		if (denied !== null) return failed(denied);
		try {
			const page = await this.boardFor(address, actor).listIssues(query);
			return saved({ cards: page.issues, nextCursor: page.next_cursor });
		} catch (error) {
			return failed(failureFromError(error));
		}
	}

	/** Read one card with its revision. */
	async getCard(address: BoardAddress, actor: BoardActor, cardId: string): Promise<BoardResult<KanbusIssueWithRevision>> {
		const denied = await this.authorize(address, actor, "read");
		if (denied !== null) return failed(denied);
		try {
			return saved(await this.boardFor(address, actor).getIssue(cardId));
		} catch (error) {
			return failed(failureFromError(error));
		}
	}

	/** Create a card. The store makes the id, the creator and the times. */
	async createCard(address: BoardAddress, actor: BoardActor, fields: NewCardFields, context: WriteContext): Promise<BoardResult<KanbusIssueWithRevision>> {
		const denied = await this.authorize(address, actor, "write");
		if (denied !== null) return failed(denied);
		const body: KanbusIssueFields = {
			title: fields.title,
			type: fields.type ?? DEFAULT_CARD_TYPE,
			...(fields.description === undefined ? {} : { description: fields.description }),
			...(fields.priority === undefined ? {} : { priority: fields.priority }),
			...(fields.labels === undefined ? {} : { labels: [...fields.labels] }),
			...(fields.parent === undefined ? {} : { parent: fields.parent }),
			...(fields.status === undefined ? {} : { status: fields.status }),
		};
		try {
			const written = await this.boardFor(address, actor).createIssue(body, {
				operationId: this.operationId(address, "create", "create", context),
				actor: actorHeaderFor(actor),
			});
			return saved({ issue: written.issue, revision: written.revision }, written.catalog_pending);
		} catch (error) {
			return failed(failureFromError(error));
		}
	}

	/**
	 * Change the title, description, priority, labels or status of a card. A plain change of status to `closed` is
	 * refused: a card closes only through `completeCard` (with evidence) or `closeCard` (with a reason).
	 */
	async updateCard(address: BoardAddress, actor: BoardActor, cardId: string, changes: CardChanges, context: WriteContext): Promise<BoardResult<KanbusIssueWithRevision>> {
		const denied = await this.authorize(address, actor, "write");
		if (denied !== null) return failed(denied);
		if (changes.status === "closed") {
			return refusal("A closed card needs evidence (complete) or a reason (close); a plain status change to closed is refused.", "closing_needs_evidence_or_reason");
		}
		const patch: KanbusIssuePatch = {
			...(changes.title === undefined ? {} : { title: changes.title }),
			...(changes.description === undefined ? {} : { description: changes.description }),
			...(changes.priority === undefined ? {} : { priority: changes.priority }),
			...(changes.labels === undefined ? {} : { labels: [...changes.labels] }),
			...(changes.status === undefined ? {} : { status: changes.status }),
		};
		if (Object.keys(patch).length === 0) return refusal("There is nothing to change: name at least one field.", "nothing_to_change");
		return this.patchCard(address, actor, cardId, patch, "update", context);
	}

	/** Add a comment to a card. */
	async commentOnCard(address: BoardAddress, actor: BoardActor, cardId: string, text: string, context: WriteContext): Promise<BoardResult<KanbusIssueWithRevision>> {
		const denied = await this.authorize(address, actor, "write");
		if (denied !== null) return failed(denied);
		if (isBlank(text)) return refusal("A comment needs text.", "comment_text_required");
		return this.writeAgainstRevision(address, actor, cardId, context, async (board, revision) => {
			const written = await board.addComment(cardId, text, {
				operationId: this.operationId(address, "comment", "comment", context),
				ifMatch: revision,
				actor: actorHeaderFor(actor),
			});
			return { issue: written.issue, revision: written.revision, catalogPending: written.catalog_pending };
		});
	}

	/**
	 * Complete a card: evidence from the system acted upon is required. Closes the card with a closing comment that holds
	 * the evidence and the custom field `closing` set to `completed`.
	 */
	async completeCard(address: BoardAddress, actor: BoardActor, cardId: string, evidence: string, context: WriteContext): Promise<BoardResult<KanbusIssueWithRevision>> {
		const denied = await this.authorize(address, actor, "write");
		if (denied !== null) return failed(denied);
		if (isBlank(evidence)) return refusal("A card cannot reach completed without evidence.", "evidence_required");
		return this.closeWithComment(address, actor, cardId, `Completed. Evidence: ${evidence.trim()}`, COMPLETED_CLOSING, "complete", context);
	}

	/** Close a card without completing it: a reason is required. Closes with a closing comment that holds the reason and `closing` set to `abandoned`. */
	async closeCard(address: BoardAddress, actor: BoardActor, cardId: string, reason: string, context: WriteContext): Promise<BoardResult<KanbusIssueWithRevision>> {
		const denied = await this.authorize(address, actor, "write");
		if (denied !== null) return failed(denied);
		if (isBlank(reason)) return refusal("A card cannot be closed without a reason.", "reason_required");
		return this.closeWithComment(address, actor, cardId, `Closed. Reason: ${reason.trim()}`, ABANDONED_CLOSING, "close", context);
	}

	/** Reopen a closed card: it is open again and has no closing time. */
	async reopenCard(address: BoardAddress, actor: BoardActor, cardId: string, context: WriteContext): Promise<BoardResult<KanbusIssueWithRevision>> {
		const denied = await this.authorize(address, actor, "write");
		if (denied !== null) return failed(denied);
		return this.patchCard(address, actor, cardId, { status: "open", custom: { closing: null } }, "reopen", context);
	}

	/** Put a card under a parent, or take it out from under its parent when no parent is named. */
	async setParent(address: BoardAddress, actor: BoardActor, cardId: string, parentId: string | null, context: WriteContext): Promise<BoardResult<KanbusIssueWithRevision>> {
		const denied = await this.authorize(address, actor, "write");
		if (denied !== null) return failed(denied);
		return this.patchCard(address, actor, cardId, { parent: parentId }, "set-parent", context);
	}

	/** Record that a card depends on another card. */
	async addDependency(address: BoardAddress, actor: BoardActor, cardId: string, targetId: string, type: DependencyType, context: WriteContext): Promise<BoardResult<KanbusIssueWithRevision>> {
		const denied = await this.authorize(address, actor, "write");
		if (denied !== null) return failed(denied);
		return this.changeDependencies(address, actor, cardId, context, "add-dependency", (existing) => [
			...existing.filter((entry) => !(entry.target === targetId && entry.type === type)),
			{ target: targetId, type },
		]);
	}

	/** Remove a recorded dependency. */
	async removeDependency(address: BoardAddress, actor: BoardActor, cardId: string, targetId: string, context: WriteContext): Promise<BoardResult<KanbusIssueWithRevision>> {
		const denied = await this.authorize(address, actor, "write");
		if (denied !== null) return failed(denied);
		return this.changeDependencies(address, actor, cardId, context, "remove-dependency", (existing) =>
			existing.filter((entry) => entry.target !== targetId),
		);
	}

	/** Delete a card. Only an owner may; a bot never deletes. The revision the deleter saw is required. */
	async deleteCard(address: BoardAddress, actor: BoardActor, cardId: string, context: WriteContext & { readonly revision: string }): Promise<BoardResult<{ readonly deleted: true }>> {
		const denied = await this.authorize(address, actor, "delete");
		if (denied !== null) return failed(denied);
		try {
			const result = await this.boardFor(address, actor).deleteIssue(cardId, {
				operationId: this.operationId(address, "delete", "delete", context),
				ifMatch: context.revision,
				actor: actorHeaderFor(actor),
			});
			return saved({ deleted: result.deleted }, result.catalog_pending);
		} catch (error) {
			return failed(await this.withCurrentCard(address, actor, cardId, failureFromError(error)));
		}
	}

	private boardFor(address: BoardAddress, actor: BoardActor): BoardClient {
		return createBoardClientForActor({
			baseUrl: this.dependencies.baseUrl,
			fetch: this.dependencies.fetch,
			actor: actorHeaderFor(actor),
		}).board(address.organizationId, address.botId);
	}

	private operationId(address: BoardAddress, action: string, step: string, context: WriteContext): string {
		return deriveBoardOperationId(["bot-board", address.organizationId, address.botId, action, step, context.operationKey]);
	}

	private async authorize(address: BoardAddress, actor: BoardActor, access: Access): Promise<BoardFailure | null> {
		if (actor.kind === "bot") {
			if (actor.botId !== address.botId) return { kind: "forbidden", code: "forbidden", message: "A bot reaches only its own board." };
			if (access === "delete") return { kind: "forbidden", code: "forbidden", message: "A bot closes cards and never deletes them." };
			return null;
		}
		const membership = await this.dependencies.memberships.getMembership(address.organizationId, actor.userId);
		if (membership === null) return { kind: "not_found", code: "not_found", message: "The board was not found." };
		if (access !== "read" && membership.role !== OWNER_ROLE) {
			return { kind: "forbidden", code: "forbidden", message: "Only an owner of the organization changes a bot's board." };
		}
		return null;
	}

	private async lifecycle(address: BoardAddress, actor: BoardActor, route: "archive" | "restore", operationKey: string): Promise<BoardResult<Record<string, unknown>>> {
		if (actor.kind === "bot") return failed({ kind: "forbidden", code: "forbidden", message: "A bot does not manage board lifecycle." });
		const denied = await this.authorize(address, actor, "write");
		if (denied !== null) return failed(denied);
		const operationId = deriveBoardOperationId(["bot-board", address.organizationId, address.botId, route, route, operationKey]);
		try {
			const board = this.boardFor(address, actor);
			const options = { operationId, actor: actorHeaderFor(actor) };
			return saved(route === "archive" ? await board.archive(options) : await board.restore(options));
		} catch (error) {
			return failed(failureFromError(error));
		}
	}

	private async resolveRevision(board: BoardClient, cardId: string, context: WriteContext): Promise<string> {
		if (context.revision !== undefined) return context.revision;
		return (await board.getIssue(cardId)).revision;
	}

	private async writeAgainstRevision(
		address: BoardAddress,
		actor: BoardActor,
		cardId: string,
		context: WriteContext,
		write: (board: BoardClient, revision: string) => Promise<{ issue: KanbusIssueWithRevision["issue"]; revision: string; catalogPending: boolean }>,
	): Promise<BoardResult<KanbusIssueWithRevision>> {
		try {
			const board = this.boardFor(address, actor);
			const revision = await this.resolveRevision(board, cardId, context);
			const written = await write(board, revision);
			return saved({ issue: written.issue, revision: written.revision }, written.catalogPending);
		} catch (error) {
			return failed(await this.withCurrentCard(address, actor, cardId, failureFromError(error)));
		}
	}

	private async patchCard(address: BoardAddress, actor: BoardActor, cardId: string, patch: KanbusIssuePatch, action: string, context: WriteContext): Promise<BoardResult<KanbusIssueWithRevision>> {
		return this.writeAgainstRevision(address, actor, cardId, context, async (board, revision) => {
			const written = await board.updateIssue(cardId, patch, {
				operationId: this.operationId(address, action, "update", context),
				ifMatch: revision,
				actor: actorHeaderFor(actor),
			});
			return { issue: written.issue, revision: written.revision, catalogPending: written.catalog_pending };
		});
	}

	private async changeDependencies(
		address: BoardAddress,
		actor: BoardActor,
		cardId: string,
		context: WriteContext,
		action: string,
		change: (existing: ReadonlyArray<{ target: string; type: string }>) => Array<{ target: string; type: string }>,
	): Promise<BoardResult<KanbusIssueWithRevision>> {
		return this.writeAgainstRevision(address, actor, cardId, context, async (board, revision) => {
			const current = await board.getIssue(cardId);
			const existing = (current.issue.dependencies ?? []).filter(
				(entry): entry is { target: string; type: string } =>
					typeof entry === "object" && entry !== null && typeof (entry as { target?: unknown }).target === "string",
			);
			const patch = { dependencies: change(existing) } as unknown as KanbusIssuePatch;
			const written = await board.updateIssue(cardId, patch, {
				operationId: this.operationId(address, action, "update", context),
				ifMatch: revision,
				actor: actorHeaderFor(actor),
			});
			return { issue: written.issue, revision: written.revision, catalogPending: written.catalog_pending };
		});
	}

	private async closeWithComment(
		address: BoardAddress,
		actor: BoardActor,
		cardId: string,
		commentText: string,
		closing: string,
		action: string,
		context: WriteContext,
	): Promise<BoardResult<KanbusIssueWithRevision>> {
		const board = this.boardFor(address, actor);
		let commented: { revision: string; catalogPending: boolean };
		try {
			const revision = await this.resolveRevision(board, cardId, context);
			const written = await board.addComment(cardId, commentText, {
				operationId: this.operationId(address, action, "closing-comment", context),
				ifMatch: revision,
				actor: actorHeaderFor(actor),
			});
			commented = { revision: written.revision, catalogPending: written.catalog_pending };
		} catch (error) {
			return failed(await this.withCurrentCard(address, actor, cardId, failureFromError(error)));
		}
		try {
			const written = await board.updateIssue(
				cardId,
				{ status: "closed", custom: { closing } },
				{
					operationId: this.operationId(address, action, "close", context),
					ifMatch: commented.revision,
					actor: actorHeaderFor(actor),
				},
			);
			return saved({ issue: written.issue, revision: written.revision }, written.catalog_pending || commented.catalogPending);
		} catch (error) {
			const failure = failureFromError(error);
			const detail = `The closing comment was saved but the card was not closed. ${failure.message}`;
			return failed(await this.withCurrentCard(address, actor, cardId, { ...failure, message: detail }));
		}
	}

	private async withCurrentCard(address: BoardAddress, actor: BoardActor, cardId: string, failure: BoardFailure): Promise<BoardFailure> {
		if (failure.kind !== "conflict") return failure;
		try {
			return { ...failure, currentCard: await this.boardFor(address, actor).getIssue(cardId) };
		} catch {
			return failure;
		}
	}
}
