import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import type { KanbusBoardIssueEntry, KanbusIssueWithRevision } from "@kanbus/api-client";
import type { BoardFailure, BoardResult } from "../board/board-failures.ts";
import type { BoardActor, BoardAddress, BotBoardService, DependencyType, WriteContext } from "../board/bot-board-service.ts";

/** The name the model calls the board tool by. */
export const BOARD_TOOL_NAME = "board";

/** Every action of the board tool. There is no delete: a bot closes cards and never deletes them. */
export const BOARD_TOOL_ACTIONS = [
	"create",
	"get",
	"list",
	"update",
	"comment",
	"complete",
	"close",
	"reopen",
	"set_parent",
	"add_dependency",
	"remove_dependency",
] as const;

/** One action of the board tool. */
export type BoardToolAction = (typeof BOARD_TOOL_ACTIONS)[number];

/** Whose board a turn's board tool acts on, and which turn it acts in. */
export type BoardToolScope = {
	readonly organizationId: string;
	readonly botId: string;
	readonly turnId: string;
};

/** The arguments a model passes to the board tool. Any board it names is ignored: the board is always the bot's own. */
export type BoardToolArguments = {
	readonly action: BoardToolAction;
	readonly card_id?: string;
	readonly title?: string;
	readonly description?: string;
	readonly type?: string;
	readonly priority?: number;
	readonly labels?: readonly string[];
	readonly status?: string;
	readonly revision?: string;
	readonly text?: string;
	readonly evidence?: string;
	readonly reason?: string;
	readonly parent_id?: string;
	readonly depends_on_id?: string;
	readonly dependency_type?: DependencyType;
	readonly limit?: number;
	readonly operation_key?: string;
};

/** What one tool call returns to the model, and whether it counts as an error. */
export type BoardToolOutcome = { readonly text: string; readonly isError: boolean };

type RenderedCard = Record<string, unknown>;

function cardOf(entry: KanbusIssueWithRevision): RenderedCard {
	return { ...entry.issue, revision: entry.revision };
}

function summaryOf(entry: KanbusBoardIssueEntry): RenderedCard {
	const { id, title, type, status, priority, parent, labels, updated_at } = entry.issue;
	return { id, title, type, status, priority, parent: parent ?? null, labels: labels ?? [], updated_at, revision: entry.revision };
}

function describeFailure(failure: BoardFailure): { outcome: string; message: string } {
	switch (failure.kind) {
		case "forbidden":
			return { outcome: "denied", message: failure.message };
		case "not_found":
			return { outcome: "not_found", message: "The card was not found on your board." };
		case "conflict":
			return { outcome: "conflict", message: `Someone else changed the card first, so your change was not applied. ${failure.message}` };
		case "operation_conflict":
			return { outcome: "operation_conflict", message: "That operation_key was already used for a different change, so nothing was applied. Use a new operation_key." };
		case "invalid":
			return { outcome: "validation_failed", message: failure.message };
		case "refused":
			return { outcome: "refused", message: failure.message };
		case "archived":
			return { outcome: "archived", message: "This board is archived and cannot be changed." };
		case "unavailable":
			return { outcome: "not_saved", message: failure.message };
	}
}

function failureOutcome(failure: BoardFailure, operationKey: string): BoardToolOutcome {
	const { outcome, message } = describeFailure(failure);
	const body: Record<string, unknown> = { outcome, saved: false, message };
	if (failure.code !== undefined) body.code = failure.code;
	if (failure.currentCard !== undefined) {
		body.current_revision = failure.currentCard.revision;
		body.current_card = cardOf(failure.currentCard);
	}
	if (failure.kind === "unavailable") body.operation_key = operationKey;
	return { text: JSON.stringify(body), isError: true };
}

function writeOutcome(result: BoardResult<KanbusIssueWithRevision>, operationKey: string): BoardToolOutcome {
	if (!result.ok) return failureOutcome(result.failure, operationKey);
	const message = result.listingMayBeBehind
		? "The change is saved: the board store confirmed the record. The listing of the board may be behind and may not show it yet; reading the card by its id returns it."
		: "The change is saved: the board store confirmed the record.";
	return {
		text: JSON.stringify({ outcome: "saved", saved: true, message, listing_may_be_behind: result.listingMayBeBehind, card: cardOf(result.value) }),
		isError: false,
	};
}

function refusalOutcome(message: string): BoardToolOutcome {
	return { text: JSON.stringify({ outcome: "refused", saved: false, message }), isError: true };
}

const REQUIRES_CARD: ReadonlySet<BoardToolAction> = new Set([
	"get",
	"update",
	"comment",
	"complete",
	"close",
	"reopen",
	"set_parent",
	"add_dependency",
	"remove_dependency",
]);

/**
 * Run one call of the board tool against the bot's own board. The board, the organization and the actor come from the
 * scope, never from the arguments. A write that reads the card first to learn its revision passes that revision to
 * `rememberRevision`, which a durable caller uses to make a replay write against the revision of the first attempt.
 *
 * @param scope The organization, bot and turn.
 * @param service The board service.
 * @param args The model's arguments.
 * @param callId The identifier of this tool call within the turn.
 * @param rememberRevision Stores the revision a read produced and returns the first one stored; identity when nothing is durable.
 * @returns The text for the model and whether it is an error.
 */
export async function runBoardToolCall(
	scope: BoardToolScope,
	service: BotBoardService,
	args: BoardToolArguments,
	callId: string,
	rememberRevision: (revision: string) => Promise<string> = async (revision) => revision,
): Promise<BoardToolOutcome> {
	const address: BoardAddress = { organizationId: scope.organizationId, botId: scope.botId };
	const actor: BoardActor = { kind: "bot", botId: scope.botId };
	const operationKey = args.operation_key ?? `${scope.turnId}/${callId}`;
	const cardId = args.card_id;
	if (REQUIRES_CARD.has(args.action) && (cardId === undefined || cardId.trim() === "")) {
		return refusalOutcome(`card_id is required for ${args.action}.`);
	}
	if (args.action === "list") {
		const result = await service.listCards(address, actor, {
			...(args.status === undefined ? {} : { status: args.status }),
			...(args.limit === undefined ? {} : { limit: args.limit }),
		});
		if (!result.ok) return failureOutcome(result.failure, operationKey);
		return {
			text: JSON.stringify({ outcome: "ok", cards: result.value.cards.map(summaryOf), next_cursor: result.value.nextCursor }),
			isError: false,
		};
	}
	if (args.action === "get") {
		const result = await service.getCard(address, actor, cardId!);
		if (!result.ok) return failureOutcome(result.failure, operationKey);
		return { text: JSON.stringify({ outcome: "ok", card: cardOf(result.value) }), isError: false };
	}
	const needsRead = args.action !== "create" && args.revision === undefined;
	let revision = args.revision;
	if (needsRead) {
		const read = await service.getCard(address, actor, cardId!);
		if (!read.ok) return failureOutcome(read.failure, operationKey);
		revision = await rememberRevision(read.value.revision);
	}
	const context: WriteContext = revision === undefined ? { operationKey } : { operationKey, revision };
	switch (args.action) {
		case "create":
			return writeOutcome(
				await service.createCard(
					address,
					actor,
					{
						title: args.title ?? "",
						...(args.type === undefined ? {} : { type: args.type }),
						...(args.description === undefined ? {} : { description: args.description }),
						...(args.priority === undefined ? {} : { priority: args.priority }),
						...(args.labels === undefined ? {} : { labels: args.labels }),
						...(args.parent_id === undefined ? {} : { parent: args.parent_id }),
					},
					context,
				),
				operationKey,
			);
		case "update":
			return writeOutcome(
				await service.updateCard(
					address,
					actor,
					cardId!,
					{
						...(args.title === undefined ? {} : { title: args.title }),
						...(args.description === undefined ? {} : { description: args.description }),
						...(args.priority === undefined ? {} : { priority: args.priority }),
						...(args.labels === undefined ? {} : { labels: args.labels }),
						...(args.status === undefined ? {} : { status: args.status }),
					},
					context,
				),
				operationKey,
			);
		case "comment":
			return writeOutcome(await service.commentOnCard(address, actor, cardId!, args.text ?? "", context), operationKey);
		case "complete":
			return writeOutcome(await service.completeCard(address, actor, cardId!, args.evidence ?? "", context), operationKey);
		case "close":
			return writeOutcome(await service.closeCard(address, actor, cardId!, args.reason ?? "", context), operationKey);
		case "reopen":
			return writeOutcome(await service.reopenCard(address, actor, cardId!, context), operationKey);
		case "set_parent":
			return writeOutcome(await service.setParent(address, actor, cardId!, args.parent_id ?? null, context), operationKey);
		case "add_dependency":
			if (args.depends_on_id === undefined) return refusalOutcome("depends_on_id is required for add_dependency.");
			return writeOutcome(
				await service.addDependency(address, actor, cardId!, args.depends_on_id, args.dependency_type ?? "blocked-by", context),
				operationKey,
			);
		case "remove_dependency":
			if (args.depends_on_id === undefined) return refusalOutcome("depends_on_id is required for remove_dependency.");
			return writeOutcome(await service.removeDependency(address, actor, cardId!, args.depends_on_id, context), operationKey);
		default:
			return refusalOutcome(`The action ${String(args.action)} is not a board action.`);
	}
}

/**
 * The board tool as a pi-durable extension: the bot's own work board in the Kanbus board service. It works without
 * summoning the computer. A call that is interrupted and run again derives the same operation id, so it replays instead
 * of repeating its write, which is why the tool is replay-safe.
 *
 * @param scope The organization, bot and turn the calls act in.
 * @param service The board service.
 * @returns The extensions to install into a registry.
 */
export function botBoardToolExtensions(scope: BoardToolScope, service: BotBoardService): Extension[] {
	const boardTool = defineTool({
		name: BOARD_TOOL_NAME,
		description:
			"Keep your own work board: create, read, list, update, comment on, complete, close and reopen cards, set a card's parent and record dependencies. A card completes only with evidence from the system you acted on and closes only with a reason. You never delete cards. The result says saved only after the board store confirmed the change; anything else was not saved. Works without summoning the computer.",
		parameters: Type.Object({
			action: Type.Union(BOARD_TOOL_ACTIONS.map((action) => Type.Literal(action))),
			card_id: Type.Optional(Type.String({ description: "The card's id. Required for every action except create and list." })),
			title: Type.Optional(Type.String({ description: "Required for create. Optional for update." })),
			description: Type.Optional(Type.String()),
			type: Type.Optional(Type.String({ description: "Card type for create. Defaults to task." })),
			priority: Type.Optional(Type.Integer()),
			labels: Type.Optional(Type.Array(Type.String(), { description: "On update, replaces the card's labels." })),
			status: Type.Optional(Type.String({ description: "On update, move the card to this status. Use complete or close to close a card. On list, show only cards in this status." })),
			revision: Type.Optional(Type.String({ description: "The revision you last saw. When omitted, the card is read first and the change applies to the revision read." })),
			text: Type.Optional(Type.String({ description: "Required for comment." })),
			evidence: Type.Optional(Type.String({ description: "Required for complete: evidence from the system you acted on." })),
			reason: Type.Optional(Type.String({ description: "Required for close." })),
			parent_id: Type.Optional(Type.String({ description: "For set_parent: the parent card. Omit to clear the parent. For create: the parent card." })),
			depends_on_id: Type.Optional(Type.String({ description: "For add_dependency and remove_dependency: the card this one waits on." })),
			dependency_type: Type.Optional(Type.Union([Type.Literal("blocked-by"), Type.Literal("relates-to")])),
			limit: Type.Optional(Type.Integer({ description: "For list: how many cards, 1 to 100." })),
			operation_key: Type.Optional(Type.String({ description: "To repeat a change that was not confirmed exactly as before, pass the operation_key the failed result gave." })),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			const outcome = await runBoardToolCall(scope, service, args as BoardToolArguments, api.callId, (revision) =>
				api.memo("revision", revision, context),
			);
			return { content: [{ type: "text", text: outcome.text }], isError: outcome.isError };
		},
	}) as unknown as ToolRegistration;
	return [defineExtension({ name: "chatticus-board", tools: [boardTool] })];
}
