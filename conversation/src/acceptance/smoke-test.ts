/**
 * The black-box smoke test of a deployed thin-turn front door.
 *
 * It speaks only HTTP: it exchanges a SigV4-signed STS GetCallerIdentity request for an integration bearer, creates a
 * bot and a channel, posts a message, steers a second post to the same bot, reads each turn's server-sent event stream
 * until the turn completes, then reloads the channel and checks the bot's reply is persisted after the human message.
 *
 * Where the environment is expected to have the bot board capability (`expectBoard`), it also exercises the bot's board
 * through the front door as the integration user, without a model: it reads the empty overview, creates, comments on,
 * moves and completes a card with evidence, abandons a second card with a reason, checks that completing a third card
 * without evidence is refused, and archives the throwaway bot's board at the end.
 */

import { DEFAULT_INTEGRATION_TEST_TENANT_ID, DEFAULT_INTEGRATION_TEST_USER_ID, INTEGRATION_TEST_SESSION_PATH } from "../auth/integration-test.ts";
import { HttpClient } from "./http-client.ts";
import { buildStsGetCallerIdentityHeaders } from "./sigv4.ts";

/** Header carrying the front door's invoke key. */
export const SMOKE_INVOKE_KEY_HEADER = "X-Chatticus-Invoke-Key";

/** Every check name the smoke test records, in order of the names below. */
export const SMOKE_CHECK_NAMES = {
	sessionExchanged: "session exchanged for an integration bearer",
	botCreated: "bot created",
	channelCreated: "channel created",
	messagePosted: "message posted and a turn admitted",
	steerAdmitted: "second post to the same bot is admitted while the turn runs",
	streamCompleted: "turn stream reached turn.completed",
	reloadOrdered: "reloaded channel orders the bot reply after the human message",
	replyPersisted: "bot reply is persisted with a body",
	steerPersisted: "steering message is persisted",
} as const;

/** Every check name the board part of the smoke test records, in order. They are recorded only when the board capability is expected. */
export const SMOKE_BOARD_CHECK_NAMES = {
	overviewEmpty: "board overview of the new bot is empty",
	cardCreated: "board card created with the integration user as its creator",
	commentAdded: "board card comment recorded under the integration user",
	cardMoved: "board card moved to in_progress",
	cardCompleted: "board card completed with evidence and read back closed",
	cardAbandoned: "board card abandoned with a reason and read back closed",
	completionRefused: "completing a board card without evidence is refused",
	boardArchived: "board archived at cleanup",
} as const;

/** The code the board routes answer with when the deployment has no board service. */
export const BOARD_SERVICE_NOT_ENABLED_CODE = "board_service_not_enabled";

/** Base class of every typed smoke test failure; `check` names the check that was being made. */
export class SmokeTestError extends Error {
	readonly check: string;

	constructor(check: string, message: string) {
		super(`${check}: ${message}`);
		this.name = new.target.name;
		this.check = check;
	}
}

/** The front door refused or could not complete an HTTP request. */
export class SmokeRequestError extends SmokeTestError {
	readonly status: number;

	constructor(check: string, status: number, detail: string) {
		super(check, `HTTP ${status} ${detail}`);
		this.status = status;
	}
}

/** The front door answered, but the answer broke an expectation. */
export class SmokeAssertionError extends SmokeTestError {}

/** What the smoke test needs to reach one front door. */
export type SmokeTestOptions = {
	baseUrl: string;
	invokeKey: string;
	credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
	tenantId?: string;
	userId?: string;
	turnTimeoutSeconds?: number;
	/**
	 * Whether the environment is expected to have the bot board capability. When true the board checks run and a front
	 * door that answers board_service_not_enabled fails them; when false or absent they are skipped.
	 */
	expectBoard?: boolean;
	fetch?: (input: string, init?: RequestInit) => Promise<Response>;
};

type JsonObject = Record<string, unknown>;

type ListedMessage = { message_id: string; seq: number; author_kind: string; author_id: string; body: string };

async function jsonOf(check: string, response: Response): Promise<JsonObject> {
	const text = await response.text();
	if (!response.ok) {
		throw new SmokeRequestError(check, response.status, text.slice(0, 300));
	}
	try {
		return JSON.parse(text) as JsonObject;
	} catch {
		throw new SmokeAssertionError(check, `response was not JSON: ${text.slice(0, 200)}`);
	}
}

function requireString(check: string, value: unknown, name: string): string {
	if (typeof value !== "string" || value === "") {
		throw new SmokeAssertionError(check, `${name} missing from the response`);
	}
	return value;
}

function assertSmoke(condition: boolean, check: string, message: string): void {
	if (!condition) {
		throw new SmokeAssertionError(check, message);
	}
}

async function exchangeSession(options: SmokeTestOptions): Promise<string> {
	const check = SMOKE_CHECK_NAMES.sessionExchanged;
	const base = options.baseUrl.replace(/\/$/, "");
	const signed = await buildStsGetCallerIdentityHeaders(options.credentials);
	const headers: Record<string, string> = { [SMOKE_INVOKE_KEY_HEADER]: options.invokeKey, ...signed };
	const sessionClient = new HttpClient({ baseUrl: base, headers, ...(options.fetch ? { fetch: options.fetch } : {}) });
	const body = await jsonOf(check, await sessionClient.post(INTEGRATION_TEST_SESSION_PATH));
	return requireString(check, body["token"], "token");
}

type BoardCard = { issue: Record<string, any>; revision: string };

async function boardCard(check: string, client: HttpClient, method: "GET" | "POST" | "PATCH", path: string, body?: unknown, revision?: string): Promise<BoardCard> {
	const response = await client.send(method, path, body, revision === undefined ? {} : { "If-Match": revision });
	const answer = await jsonOf(check, response);
	const issue = answer["issue"] as Record<string, any> | undefined;
	assertSmoke(issue !== undefined && typeof issue["id"] === "string", check, `the answer carries no card: ${JSON.stringify(answer).slice(0, 200)}`);
	return { issue: issue as Record<string, any>, revision: requireString(check, answer["revision"], "revision") };
}

function lastCommentOf(issue: Record<string, any>): { author: string; text: string } | undefined {
	const comments = (issue["comments"] ?? []) as Array<{ author: string; text: string }>;
	return comments[comments.length - 1];
}

async function closedCardOf(check: string, client: HttpClient, boardPath: string, id: string, closing: string, closingText: string, actor: string): Promise<void> {
	const { issue } = await boardCard(check, client, "GET", `${boardPath}/cards/${id}`);
	assertSmoke(issue["status"] === "closed", check, `the card has the status ${String(issue["status"])}, not closed`);
	assertSmoke(typeof issue["closed_at"] === "string" && issue["closed_at"] !== "", check, "the closed card has no closing time");
	assertSmoke(issue["custom"]?.["closing"] === closing, check, `the card records the closing ${JSON.stringify(issue["custom"]?.["closing"])}, not ${closing}`);
	const comment = lastCommentOf(issue);
	assertSmoke(comment !== undefined && comment.text.includes(closingText), check, `the last comment does not hold ${JSON.stringify(closingText)}`);
	assertSmoke(comment?.author === actor, check, `the closing comment is by ${String(comment?.author)}, not ${actor}`);
	assertSmoke(issue["creator"] === actor, check, `the card's creator is ${String(issue["creator"])}, not ${actor}`);
}

async function runBoardChecksOnReachedBoard(client: HttpClient, boardPath: string, actor: string, checks: string[]): Promise<void> {
	const stamp = Date.now().toString(36);
	const names = SMOKE_BOARD_CHECK_NAMES;

	const first = await boardCard(names.cardCreated, client, "POST", `${boardPath}/cards`, { title: `Smoke card ${stamp}`, description: "Created by the acceptance smoke test." });
	assertSmoke(first.issue["creator"] === actor, names.cardCreated, `the card's creator is ${String(first.issue["creator"])}, not ${actor}`);
	checks.push(names.cardCreated);

	const commentText = `Smoke comment ${stamp}`;
	const commented = await boardCard(names.commentAdded, client, "POST", `${boardPath}/cards/${first.issue["id"]}/comments`, { text: commentText }, first.revision);
	const comment = lastCommentOf(commented.issue);
	assertSmoke(comment?.text === commentText && comment.author === actor, names.commentAdded, `the comment is ${JSON.stringify(comment)}`);
	checks.push(names.commentAdded);

	const moved = await boardCard(names.cardMoved, client, "PATCH", `${boardPath}/cards/${first.issue["id"]}`, { status: "in_progress" }, commented.revision);
	assertSmoke(moved.issue["status"] === "in_progress", names.cardMoved, `the card has the status ${String(moved.issue["status"])}`);
	checks.push(names.cardMoved);

	const evidence = `Smoke evidence ${stamp}`;
	await boardCard(names.cardCompleted, client, "POST", `${boardPath}/cards/${first.issue["id"]}/complete`, { evidence }, moved.revision);
	await closedCardOf(names.cardCompleted, client, boardPath, first.issue["id"], "completed", evidence, actor);
	checks.push(names.cardCompleted);

	const second = await boardCard(names.cardAbandoned, client, "POST", `${boardPath}/cards`, { title: `Smoke abandoned card ${stamp}` });
	const reason = `Smoke reason ${stamp}`;
	await boardCard(names.cardAbandoned, client, "POST", `${boardPath}/cards/${second.issue["id"]}/abandon`, { reason }, second.revision);
	await closedCardOf(names.cardAbandoned, client, boardPath, second.issue["id"], "abandoned", reason, actor);
	checks.push(names.cardAbandoned);

	const third = await boardCard(names.completionRefused, client, "POST", `${boardPath}/cards`, { title: `Smoke unfinished card ${stamp}` });
	const refusal = await client.send("POST", `${boardPath}/cards/${third.issue["id"]}/complete`, { evidence: "" }, { "If-Match": third.revision });
	const refusalText = await refusal.text();
	assertSmoke(refusal.status === 422 && refusalText.includes("evidence_required"), names.completionRefused, `completing without evidence answered HTTP ${refusal.status} ${refusalText.slice(0, 200)}`);
	const unfinished = await boardCard(names.completionRefused, client, "GET", `${boardPath}/cards/${third.issue["id"]}`);
	assertSmoke(unfinished.issue["status"] !== "closed", names.completionRefused, "the card was closed without evidence");
	checks.push(names.completionRefused);
}

/** Whether the board of the throwaway bot was reached, so that cleanup knows to archive it. */
type BoardReach = { reached: boolean };

async function runBoardChecks(client: HttpClient, boardPath: string, botId: string, userId: string, checks: string[], reach: BoardReach): Promise<void> {
	const names = SMOKE_BOARD_CHECK_NAMES;
	const actor = `chatticus:user:${userId}`;

	const overviewResponse = await client.get(boardPath);
	const overviewText = await overviewResponse.text();
	if (overviewResponse.status === 404 && overviewText.includes(BOARD_SERVICE_NOT_ENABLED_CODE)) {
		throw new SmokeAssertionError(names.overviewEmpty, `the environment was expected to have the bot board capability but answered ${BOARD_SERVICE_NOT_ENABLED_CODE}`);
	}
	if (!overviewResponse.ok) {
		throw new SmokeRequestError(names.overviewEmpty, overviewResponse.status, overviewText.slice(0, 300));
	}
	reach.reached = true;
	const overview = JSON.parse(overviewText) as JsonObject;
	assertSmoke(overview["bot_id"] === botId, names.overviewEmpty, "the overview names a different bot");
	assertSmoke(Array.isArray(overview["cards"]) && overview["cards"].length === 0, names.overviewEmpty, `the new bot's board is not empty: ${overviewText.slice(0, 200)}`);
	assertSmoke(typeof (overview["configuration"] as JsonObject | undefined)?.["project_key"] === "string", names.overviewEmpty, "the overview carries no board configuration");
	checks.push(names.overviewEmpty);

	await runBoardChecksOnReachedBoard(client, boardPath, actor, checks);
}

async function archiveBoard(client: HttpClient, boardPath: string): Promise<void> {
	const archived = await client.send("POST", `${boardPath}/archive`, {});
	const archivedText = await archived.text();
	if (!archived.ok) throw new SmokeRequestError(SMOKE_BOARD_CHECK_NAMES.boardArchived, archived.status, archivedText.slice(0, 300));
}

/**
 * Run the smoke test against one front door.
 *
 * @param options How to reach the front door and authenticate to it.
 * @param checks Receives each check name as it passes.
 * @throws SmokeTestError The first check that fails, named in the error.
 */
export async function runSmokeTest(options: SmokeTestOptions, checks: string[]): Promise<void> {
	const tenantId = options.tenantId ?? DEFAULT_INTEGRATION_TEST_TENANT_ID;
	const userId = options.userId ?? DEFAULT_INTEGRATION_TEST_USER_ID;
	const turnTimeoutSeconds = options.turnTimeoutSeconds ?? 120;
	const organizationPath = `/orgs/${tenantId}`;

	const bearer = await exchangeSession(options);
	checks.push(SMOKE_CHECK_NAMES.sessionExchanged);
	const client = new HttpClient({
		baseUrl: options.baseUrl,
		headers: { [SMOKE_INVOKE_KEY_HEADER]: options.invokeKey, Authorization: `Bearer ${bearer}` },
		timeout: (turnTimeoutSeconds + 30) * 1000,
		...(options.fetch ? { fetch: options.fetch } : {}),
	});

	const botName = `smoke-${Date.now().toString(36)}`;
	const bot = await jsonOf(SMOKE_CHECK_NAMES.botCreated, await client.post(`${organizationPath}/bots`, { name: botName }));
	const botId = requireString(SMOKE_CHECK_NAMES.botCreated, bot["bot_id"], "bot_id");
	checks.push(SMOKE_CHECK_NAMES.botCreated);

	const boardPath = `${organizationPath}/bots/${botId}/board`;
	const reach: BoardReach = { reached: false };
	let failure: unknown = null;
	try {
		if (options.expectBoard === true) {
			await runBoardChecks(client, boardPath, botId, userId, checks, reach);
		}
		const channel = await jsonOf(
			SMOKE_CHECK_NAMES.channelCreated,
			await client.post(`${organizationPath}/channels`, { user_id: userId, bot_ids: [botId], kind: "direct", name: null }),
		);
		const channelId = requireString(SMOKE_CHECK_NAMES.channelCreated, channel["channel_id"], "channel_id");
		checks.push(SMOKE_CHECK_NAMES.channelCreated);

		const postPath = `${organizationPath}/channels/${channelId}/messages`;
		const posted = await jsonOf(
			SMOKE_CHECK_NAMES.messagePosted,
			await client.post(postPath, {
				author_kind: "human",
				author_id: userId,
				body: "Smoke test: reply with one short sentence.",
				addressed_to_bot_id: botId,
			}),
		);
		const humanMessage = posted["message"] as ListedMessage;
		const firstTurnId = requireString(SMOKE_CHECK_NAMES.messagePosted, posted["turn_id"], "turn_id");
		checks.push(SMOKE_CHECK_NAMES.messagePosted);

		const steered = await jsonOf(
			SMOKE_CHECK_NAMES.steerAdmitted,
			await client.post(postPath, {
				author_kind: "human",
				author_id: userId,
				body: "Smoke test steering: keep it brief.",
				addressed_to_bot_id: botId,
			}),
		);
		const steeringMessage = steered["message"] as ListedMessage;
		const steeringTurnId = requireString(SMOKE_CHECK_NAMES.steerAdmitted, steered["turn_id"], "turn_id");
		checks.push(SMOKE_CHECK_NAMES.steerAdmitted);

		const turnIds = firstTurnId === steeringTurnId ? [firstTurnId] : [firstTurnId, steeringTurnId];
		const completedMessageSeqs: number[] = [];
		for (const turnId of turnIds) {
			const outcome = await client.streamTurnEvents(turnId, organizationPath, undefined, undefined, turnTimeoutSeconds);
			const completed = outcome.events.find((event) => event["kind"] === "turn.completed");
			const last = outcome.events[outcome.events.length - 1];
			const lastEvent = last === undefined ? "no events" : `${String(last["kind"])} ${String(last["body"] ?? "")}`.trim();
			assertSmoke(completed !== undefined, SMOKE_CHECK_NAMES.streamCompleted, `turn ${turnId} did not complete; last event ${lastEvent}`);
			completedMessageSeqs.push(Number((completed as JsonObject)["message_seq"]));
		}
		checks.push(SMOKE_CHECK_NAMES.streamCompleted);

		const reloaded = await jsonOf(SMOKE_CHECK_NAMES.reloadOrdered, await client.get(`${postPath}?after=0`));
		const messages = reloaded["messages"] as ListedMessage[];
		const sequences = messages.map((message) => message.seq);
		assertSmoke(
			sequences.every((seq, index) => index === 0 || (sequences[index - 1] as number) < seq),
			SMOKE_CHECK_NAMES.reloadOrdered,
			`messages are not in ascending seq order: ${JSON.stringify(sequences)}`,
		);
		const humanIndex = messages.findIndex((message) => message.message_id === humanMessage.message_id);
		const replyIndex = messages.findIndex((message) => message.seq === completedMessageSeqs[0]);
		assertSmoke(humanIndex >= 0, SMOKE_CHECK_NAMES.reloadOrdered, "the human message is missing from the reloaded channel");
		assertSmoke(replyIndex > humanIndex, SMOKE_CHECK_NAMES.reloadOrdered, "the bot reply is not after the human message");
		checks.push(SMOKE_CHECK_NAMES.reloadOrdered);

		for (const seq of completedMessageSeqs) {
			const reply = messages.find((message) => message.seq === seq);
			assertSmoke(
				reply !== undefined && reply.author_kind === "bot" && reply.author_id === botId && reply.body.trim() !== "",
				SMOKE_CHECK_NAMES.replyPersisted,
				`no persisted bot reply with a body at seq ${seq}`,
			);
		}
		checks.push(SMOKE_CHECK_NAMES.replyPersisted);

		assertSmoke(
			messages.some((message) => message.message_id === steeringMessage.message_id && message.author_kind === "human"),
			SMOKE_CHECK_NAMES.steerPersisted,
			"the steering message is missing from the reloaded channel",
		);
		checks.push(SMOKE_CHECK_NAMES.steerPersisted);
	} catch (error) {
		failure = error;
	}
	if (reach.reached) {
		try {
			await archiveBoard(client, boardPath);
			if (failure === null) checks.push(SMOKE_BOARD_CHECK_NAMES.boardArchived);
		} catch (error) {
			if (failure === null) failure = error;
		}
	}
	if (failure !== null) throw failure;
}
