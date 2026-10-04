import { appendFileSync } from "node:fs";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
	type Conversation,
	createRegistry,
	defineExtension,
	defineTool,
	type Extension,
	Harness,
	hook,
	section,
	ToolTask,
} from "@earendil-works/pi-durable";
import { config } from "dotenv";
import { DynamoDbStorage } from "./dynamodb-storage.ts";
import { createLocalClient, ensureTable } from "./table.ts";

export const context: Context = BACKGROUND_CONTEXT;
export const TABLE_NAME = "pi-durable-spike";
export const MODEL = { provider: "openai", modelId: "gpt-5-nano" } as const;

if (process.env.OPENAI_API_KEY === undefined) config({ path: "/Users/home/Projects/Chattic.us/.env", quiet: true });

/** Where every real execution of a computer tool is recorded, one JSON line each, so duplicates are countable. */
export const executionLog = (): string => process.env.PI_SPIKE_EXECUTION_LOG ?? "";

/** What the owner process can do: a Lambda owner has no computer; a computer owner can execute computer tools. */
export type Capability = "lambda" | "computer";

export type OwnerOptions = {
	readonly storageId: string;
	readonly fence: number;
	readonly name: string;
	readonly capability: Capability;
	/** Milliseconds `run_terminal` sleeps on the computer, to give a crash test a window mid-tool. */
	readonly toolDelayMs?: number;
	/** Commands for which the approval hook blocks the call with a reason. */
	readonly blockedCommands?: readonly string[];
	readonly onParked?: () => void;
	/** Replay policy of `run_terminal`; the default is `safe`. */
	readonly replay?: "safe" | "unsafe";
};

export type Owner = {
	readonly harness: Harness;
	readonly root: Conversation;
	readonly storage: DynamoDbStorage;
	close(): Promise<void>;
};

const sleep = (milliseconds: number, signal: AbortSignal | undefined) =>
	new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, milliseconds);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(signal.reason ?? new Error("aborted"));
		});
	});

function logExecution(event: Record<string, unknown>): void {
	if (executionLog() !== "") appendFileSync(executionLog(), `${JSON.stringify({ ...event, at: Date.now() })}\n`);
}

/**
 * The `run_terminal` tool. On the computer it "runs" a command deterministically and logs the execution.
 * On a Lambda owner it never executes: it reports that the turn must move to the computer and then waits for the
 * owner to close, which stops the invocation without an outcome, leaving the durable intent for the next owner.
 */
function terminalTool(options: OwnerOptions) {
	return defineTool({
		name: "run_terminal",
		description:
			"Run a shell command on the team's Linux computer and return its output. Use it whenever the user asks for a command's output.",
		parameters: Type.Object({ command: Type.String() }),
		replay: options.replay ?? "safe",
		execute: async (args, api, toolContext) => {
			if (options.capability === "lambda") {
				options.onParked?.();
				await new Promise<never>((_, reject) => {
					toolContext.abortSignal?.addEventListener("abort", () => reject(new Error("owner closed for handoff")));
				});
			}
			api.output(`$ ${args.command}\n`);
			logExecution({ phase: "started", owner: options.name, taskId: api.taskId, command: args.command });
			if (options.toolDelayMs !== undefined) await sleep(options.toolDelayMs, toolContext.abortSignal);
			const output =
				args.command.trim() === "uname -a"
					? "Linux ada-computer 6.8.0-1012-aws #13-Ubuntu SMP x86_64 GNU/Linux"
					: `ran: ${args.command} (exit 0, nonce ${Buffer.from(args.command).toString("hex").slice(0, 8)})`;
			logExecution({ phase: "finished", owner: options.name, taskId: api.taskId, command: args.command });
			return { content: [{ type: "text", text: output }] };
		},
	});
}

function extensions(options: OwnerOptions): Extension[] {
	const blocked = new Set(options.blockedCommands ?? []);
	return [
		defineExtension({
			name: "chatticus",
			sections: [
				section(
					"preamble",
					() =>
						"You are Ada, a teammate in a shared Chatticus channel. Messages from humans other than the requester are prefixed with [from NAME]. Be brief.",
					{ tag: false },
				),
			],
		}),
		defineExtension({
			name: "computer",
			tools: [terminalTool(options)],
			hooks: [
				hook(ToolTask, {
					beforeTool: (call) => {
						const command = (call.arguments as { command?: string }).command ?? "";
						return blocked.has(command) ? { block: `needs approval: ${command}` } : undefined;
					},
				}),
			],
		}),
	];
}

/**
 * Open one turn owner: claim the fence, open the DynamoDB storage under it, and open the Harness on it.
 *
 * @param options Owner options.
 * @returns The open owner.
 */
export async function openOwner(options: OwnerOptions): Promise<Owner> {
	const client = createLocalClient();
	await ensureTable(client, TABLE_NAME);
	await DynamoDbStorage.claimOwnership({ client, tableName: TABLE_NAME, storageId: options.storageId, fence: options.fence });
	const storage = await DynamoDbStorage.open({
		client,
		tableName: TABLE_NAME,
		storageId: options.storageId,
		fence: options.fence,
	});
	const models = createModels();
	models.setProvider(openaiProvider());
	const registry = createRegistry();
	for (const extension of extensions(options)) registry.install(extension);
	const harness = await Harness.open(storage, { models, registry }, context);
	const root = await harness.root(context, { agent: { model: MODEL } });
	return {
		harness,
		root,
		storage,
		close: async () => {
			await harness.close(context);
		},
	};
}

/**
 * The model-visible transcript of the root conversation, oldest first, compacted to role and short text.
 *
 * @param owner Open owner.
 * @returns One line per model message.
 */
export async function transcript(owner: Owner): Promise<string[]> {
	const page = await owner.storage.scanEntries({ conversationId: owner.root.id }, 1000, undefined, context);
	const lines: string[] = [];
	for (const entry of [...page.items].reverse()) {
		for (const message of entry.model ?? []) {
			const content = (message as { content: unknown }).content;
			const parts = Array.isArray(content) ? content : [{ type: "text", text: String(content) }];
			const summary = parts
				.map((part: { type: string; text?: string; name?: string; arguments?: unknown }) =>
					part.type === "text"
						? part.text
						: part.type === "toolCall"
							? `toolCall ${part.name}(${JSON.stringify(part.arguments)})`
							: part.type === "thinking"
								? "[thinking]"
								: `[${part.type}]`,
				)
				.join(" ");
			const role = (message as { role: string }).role;
			const stop = (message as { stopReason?: string }).stopReason;
			lines.push(`#${entry.id} ${entry.kind} ${role}${stop ? `(${stop})` : ""}: ${summary.slice(0, 160)}`);
		}
	}
	return lines;
}
