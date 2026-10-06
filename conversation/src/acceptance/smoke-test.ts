/**
 * The black-box smoke test of a deployed thin-turn front door.
 *
 * It speaks only HTTP: it exchanges a SigV4-signed STS GetCallerIdentity request for an integration bearer, creates a
 * bot and a channel, posts a message, steers a second post to the same bot, reads each turn's server-sent event stream
 * until the turn completes, then reloads the channel and checks the bot's reply is persisted after the human message.
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
}
