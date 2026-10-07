/**
 * One owner process of the raw handoff scenario: pi-durable and the production session storage, no control plane.
 *
 * Roles (first argument):
 * - `a`  Lambda-like owner. Registers the coding tools as park tools (same names and schemas, `replay: "safe"`).
 *        It submits the prompt, parks on the first tool call and closes.
 * - `b`  container-like owner. Opens the same storage with a higher fence and registers pi-durable's own coding tools
 *        (read, write, edit, bash) over a `NodeExecutionEnv` rooted at a workspace directory. It resubmits the same
 *        request id and runs the turn to its end.
 * - `a2` Lambda-like owner for a follow-up message in the same conversation.
 *
 * Environment: SPIKE_STORAGE_ID, SPIKE_JOURNAL, SPIKE_WORKSPACE (role b), SPIKE_MODEL (`faux` or `openai`),
 * SPIKE_B_VARIANT (`safe`, `unsafe`, `missing` or `schema`), SPIKE_PROMPT.
 */
import { createRegistry, defineExtension, Harness, type Extension, type ToolRegistration, watchEvents } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Type } from "@earendil-works/pi-ai";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { ScriptedProvider } from "../../../conversation/features-support/fakes/scripted-provider.ts";
import { createOpenAiModels } from "../../../conversation/src/turn/openai-models.ts";
import { openOwnerStorage } from "../../../conversation/src/pi/session.ts";
import { commitObjects, dynamoClient, fenceRanges, journal, PI_BUCKET, PI_TABLE, s3Client } from "./common.ts";

const role = process.argv[2] ?? "a";
const storageId = process.env.SPIKE_STORAGE_ID!;
const ownerName = role.toUpperCase();
const context = BACKGROUND_CONTEXT;
const useFaux = (process.env.SPIKE_MODEL ?? "faux") === "faux";
const prompt =
	process.env.SPIKE_PROMPT ??
	"Create the file hello.txt containing 'hello from Chatticus', list the directory with ls, then change 'hello' to 'HELLO' in the file. Then tell me you are done.";

/** The scripted model of one role. Each process has its own script, as each process has its own model client. */
function fauxScript(): ScriptedProvider {
	const scripted = new ScriptedProvider("openai", "scripted-model");
	if (role === "a") {
		scripted.toolCall("write", { path: "hello.txt", content: "hello from Chatticus\n" }, "I will create the file.");
	} else if (role === "b") {
		scripted.callCount = 100;
		scripted
			.toolCall("bash", { command: "ls -l && cat /etc/os-release | head -1 && git --version && cat hello.txt" }, "Now I list the directory.")
			.toolCall("edit", { path: "hello.txt", edits: [{ oldText: "hello", newText: "HELLO" }] }, "Now I edit the file.")
			.reply("Done. The file hello.txt exists and now says HELLO from Chatticus.");
	} else {
		scripted.callCount = 200;
		scripted.reply("I created hello.txt, listed the directory and edited the file to say HELLO.");
	}
	return scripted;
}

const scripted = useFaux ? fauxScript() : null;
const models: Models = scripted === null ? createOpenAiModels() : (() => {
	const created = createModels();
	created.setProvider(scripted.provider);
	return created;
})();
const agent = useFaux
	? { model: { provider: "openai", modelId: "scripted-model" }, thinkingLevel: "off" as const }
	: { model: { provider: "openai", modelId: "gpt-5-nano" }, thinkingLevel: "minimal" as const };

const toolList = (CodingTools.tools ?? []) as readonly ToolRegistration[];

/** The coding tools with the same names and schemas, whose `execute` parks the call and waits to be closed. */
function parkExtension(onPark: (call: { name: string; callId: string }) => void): Extension {
	const tools = toolList.map(
		(tool) =>
			({
				...tool,
				replay: "safe" as const,
				execute: async (args: unknown, api: { callId: string }, toolContext: { abortSignal?: AbortSignal }) => {
					journal(ownerName, "tool.park", { tool: tool.name, callId: api.callId, args });
					onPark({ name: tool.name, callId: api.callId });
					await new Promise<never>((_resolve, reject) => {
						toolContext.abortSignal?.addEventListener("abort", () => reject(new Error("owner closed for handoff")));
					});
					throw new Error("unreachable");
				},
			}) as unknown as ToolRegistration,
	);
	return defineExtension({ name: "coding", tools });
}

/** The container's tools. The variants show which parts of the contract pi-durable checks on a handoff. */
function localExtension(variant: string): Extension {
	const logged = (tool: ToolRegistration, replay: "safe" | "unsafe"): ToolRegistration =>
		({
			...tool,
			replay,
			execute: async (args: unknown, api: { callId: string }, toolContext: unknown) => {
				journal(ownerName, "tool.run.local", { tool: tool.name, callId: api.callId, variant });
				return (tool.execute as (...rest: unknown[]) => Promise<unknown>)(args, api, toolContext);
			},
		}) as unknown as ToolRegistration;
	if (variant === "missing") return defineExtension({ name: "coding", tools: [] });
	if (variant === "unsafe") return defineExtension({ name: "coding", tools: toolList.map((tool) => logged(tool, "unsafe")) });
	if (variant === "schema") {
		const changed = toolList.map((tool) =>
			tool.name === "write"
				? ({ ...logged(tool, "safe"), parameters: Type.Object({ path: Type.String(), content: Type.String(), mode: Type.String() }) } as unknown as ToolRegistration)
				: logged(tool, "safe"),
		);
		return defineExtension({ name: "coding", tools: changed });
	}
	return defineExtension({ name: "coding", tools: toolList.map((tool) => logged(tool, "safe")) });
}

const summarizeEntries = async (storage: Awaited<ReturnType<typeof openOwnerStorage>>["storage"], conversationId: number): Promise<string[]> => {
	const page = await storage.scanEntries({ conversationId }, 1000, undefined, context);
	const lines: string[] = [];
	for (const entry of [...page.items].reverse()) {
		for (const message of entry.model ?? []) {
			const content = (message as { content: unknown }).content;
			const parts = Array.isArray(content) ? content : [{ type: "text", text: String(content) }];
			const text = parts
				.map((part: { type: string; text?: string; name?: string; arguments?: unknown }) =>
					part.type === "text" ? part.text : part.type === "toolCall" ? `toolCall ${part.name}(${JSON.stringify(part.arguments)})` : `[${part.type}]`,
				)
				.join(" ");
			lines.push(`#${entry.id} ${(message as { role: string }).role}: ${text.replace(/\s+/g, " ").slice(0, 150)}`);
		}
	}
	return lines;
};

const tasksOf = async (storage: Awaited<ReturnType<typeof openOwnerStorage>>["storage"]) =>
	(await storage.scanTasks({}, 100, undefined, context)).items.map((task) => ({
		id: task.id,
		kind: task.kind,
		status: task.state.status,
		phase: (task.state.checkpoint as { phase?: string } | undefined)?.phase,
		outcome: task.state.outcome?.status,
	}));

async function main(): Promise<void> {
	journal(ownerName, "owner.boot", { nodeVersion: process.version, platform: `${process.platform}/${process.arch}`, uptimeMs: Math.round(process.uptime() * 1000) });
	const client = dynamoClient();
	const s3 = s3Client();
	const opened = performance.now();
	const { storage, fence } = await openOwnerStorage(storageId, { client, s3, tableName: PI_TABLE, bucket: PI_BUCKET });
	let parkedCall: { name: string; callId: string } | null = null;
	let signalParked: () => void = () => undefined;
	const parked = new Promise<void>((resolve) => {
		signalParked = resolve;
	});
	const variant = process.env.SPIKE_B_VARIANT ?? "safe";
	const registry = createRegistry();
	registry.install(
		role === "b"
			? localExtension(variant)
			: parkExtension((call) => {
					parkedCall ??= call;
					signalParked();
				}),
	);
	const workspace = process.env.SPIKE_WORKSPACE ?? "/tmp/spike-workspace";
	const harness = await Harness.open(
		storage,
		{
			models,
			registry,
			settings: { retry: { maxRetries: 0, baseDelayMs: 1 } },
			...(role === "b" ? { env: () => new NodeExecutionEnv({ cwd: workspace }) } : {}),
		},
		context,
	);
	journal(ownerName, "owner.open", { fence, storageId, ms: Math.round(performance.now() - opened) });
	const root = await harness.root(context, { agent });
	await root.configure(agent, context);
	const events: string[] = [];
	const stream = await watchEvents(harness, root.id, context);
	stream.start(async (batch) => {
		for (const event of batch) {
			if (event.type === "tool_execution_start") journal(ownerName, "event.tool_execution_start", { tool: event.toolName, callId: event.toolCallId });
			if (event.type === "tool_execution_end") journal(ownerName, "event.tool_execution_end", { tool: event.toolName, callId: event.toolCallId });
			events.push(event.type);
		}
	});
	if (role === "a") {
		journal(ownerName, "tasks.at_open", { tasks: await tasksOf(storage) });
		const submission = await root.submit({ type: "input", content: prompt, requestId: "turn:1" }, context);
		const raced = await Promise.race([parked.then(() => "parked"), submission.wait(context).then((record) => `settled:${record.status}`)]);
		journal(ownerName, "owner.outcome", { outcome: raced, parkedCall, tasks: await tasksOf(storage) });
		await stream.stop();
		await harness.close(context);
		journal(ownerName, "owner.closed", {});
	} else if (role === "b") {
		journal(ownerName, "tasks.at_open", { tasks: await tasksOf(storage) });
		harness.resume();
		const started = performance.now();
		const submission = await root.submit({ type: "input", content: "", requestId: "turn:1" }, context);
		const settled = await Promise.race([
			submission.wait(context),
			new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("B did not settle in 60 s")), 60_000)),
		]);
		await new Promise((resolve) => setTimeout(resolve, 150));
		journal(ownerName, "owner.outcome", {
			status: settled.status,
			ms: Math.round(performance.now() - started),
			tasks: await tasksOf(storage),
			transcript: await summarizeEntries(storage, root.id),
		});
		await stream.stop();
		await harness.close(context);
		journal(ownerName, "owner.closed", {});
	} else {
		harness.resume();
		const submission = await root.submit({ type: "input", content: "What did you just do in the workspace?", requestId: "turn:2" }, context);
		const settled = await submission.wait(context);
		await new Promise((resolve) => setTimeout(resolve, 150));
		const lastRequest = scripted === null ? "(real model)" : JSON.parse(scripted.requests[0] ?? "{}");
		const messages = typeof lastRequest === "string" ? [] : ((lastRequest as { messages?: Array<{ role: string; content: unknown }> }).messages ?? []);
		journal(ownerName, "owner.outcome", {
			status: settled.status,
			modelRequestRoles: messages.map((message) => message.role),
			modelRequestToolResults: messages
				.filter((message) => message.role === "toolResult")
				.map((message) => JSON.stringify(message.content).slice(0, 200)),
			transcript: await summarizeEntries(storage, root.id),
		});
		await stream.stop();
		await harness.close(context);
	}
	const commits = await commitObjects(s3, storageId);
	journal(ownerName, "commits.by_fence", { ranges: fenceRanges(commits), total: commits.length });
	client.destroy();
	s3.destroy();
}

main().then(
	() => process.exit(0),
	(error: unknown) => {
		journal(ownerName, "owner.error", { name: (error as Error).name, message: (error as Error).message, stack: (error as Error).stack?.split("\n").slice(0, 6) });
		process.exit(1);
	},
);
