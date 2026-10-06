import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { type AgentEvent, defineExtension, defineTool, type Extension, type ToolRegistration, watchEvents } from "@earendil-works/pi-durable";
import { beforeAll, describe, expect, it } from "vitest";
import { ScriptedProvider } from "../features-support/fakes/scripted-provider.ts";
import { findStorageFailure, OwnershipLost } from "../src/pi/errors.ts";
import { type OwnerSession, openOwnerSession } from "../src/pi/session.ts";
import { storageIdFor } from "../src/storage/storage-support.ts";
import { createPiSessionBucket, createPiSessionTable } from "../src/storage/table-definition.ts";

const endpoint = process.env.CHATTICUS_TEST_AWS_ENDPOINT ?? "http://127.0.0.1:5555";
const credentials = { accessKeyId: "test", secretAccessKey: "test" };
const client = new DynamoDBClient({ endpoint, region: "us-east-1", credentials, maxAttempts: 1 });
const s3 = new S3Client({ endpoint, region: "us-east-1", credentials, forcePathStyle: true, maxAttempts: 1 });
const tableName = "computer-park-resume";
const bucket = "computer-park-resume";

beforeAll(async () => {
	await createPiSessionTable(client, tableName);
	await createPiSessionBucket(s3, bucket);
});

type Action = { callId: string; result: string | null };

/** The durable action record the real build keeps in DynamoDB; here a map shared by both owners. */
class Actions {
	readonly byCall = new Map<string, Action>();
	readonly lookups: string[] = [];
}

function lookupOrParkTool(actions: Actions, onPark: () => void): Extension {
	const tool = defineTool({
		name: "run_terminal",
		description: "Run a shell command on the organization's computer.",
		parameters: Type.Object({ command: Type.String() }),
		replay: "safe",
		execute: async (_args, api, toolContext) => {
			actions.lookups.push(api.callId);
			const found = actions.byCall.get(api.callId);
			if (found?.result !== undefined && found.result !== null) {
				return { content: [{ type: "text", text: found.result }] };
			}
			if (found === undefined) actions.byCall.set(api.callId, { callId: api.callId, result: null });
			onPark();
			await new Promise<never>((_resolve, reject) => {
				toolContext.abortSignal?.addEventListener("abort", () => reject(new Error("owner closed for handoff")));
			});
			throw new Error("unreachable");
		},
	}) as unknown as ToolRegistration;
	return defineExtension({ name: "computer", tools: [tool] });
}

async function openOwner(storageId: string, scripted: ScriptedProvider, actions: Actions, onPark: () => void): Promise<OwnerSession> {
	const models = createModels();
	models.setProvider(scripted.provider);
	return openOwnerSession(storageId, {
		client,
		s3,
		tableName,
		bucket,
		models,
		extensions: [lookupOrParkTool(actions, onPark)],
		context: BACKGROUND_CONTEXT,
		settings: { retry: { maxRetries: 0, baseDelayMs: 1 } },
	});
}

describe("parking a replay-safe computer tool and resuming on a new owner", () => {
	it("runs the tool once on the new owner and never settles the stale owner", async () => {
		const storageId = storageIdFor("tenant", "bot", randomUUID());
		const scripted = new ScriptedProvider();
		scripted.toolCall("run_terminal", { command: "uname -a" }, "I will run it.").reply("The computer says Linux.");
		const actions = new Actions();
		let parked!: () => void;
		const parkSignal = new Promise<void>((resolve) => {
			parked = resolve;
		});
		const first = await openOwner(storageId, scripted, actions, parked);
		const agent = { model: { provider: "openai", modelId: scripted.modelId }, thinkingLevel: "off" as const };
		const root = await first.harness.root(BACKGROUND_CONTEXT, { agent });
		await root.configure(agent, BACKGROUND_CONTEXT);
		const submission = await root.submit({ type: "input", content: "run uname", requestId: "turn:1" }, BACKGROUND_CONTEXT);
		let firstOutcome = "pending";
		void submission.wait(BACKGROUND_CONTEXT).then(
			(record) => {
				firstOutcome = `resolved ${record.status}`;
			},
			(error: Error) => {
				firstOutcome = `rejected ${error.message}`;
			},
		);
		await parkSignal;
		const [callId] = [...actions.byCall.keys()];
		expect(actions.byCall.size).toBe(1);

		await first.close();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(firstOutcome).toBe("rejected Harness is closed");

		actions.byCall.get(callId!)!.result = "Linux computer 6.8";
		const second = await openOwner(storageId, scripted, actions, () => {
			throw new Error("the new owner must not park");
		});
		expect(second.fence).toBeGreaterThan(first.fence);
		const root2 = await second.harness.root(BACKGROUND_CONTEXT, { agent });
		const secondEvents: string[] = [];
		const stream = await watchEvents(second.harness, root2.id, BACKGROUND_CONTEXT);
		stream.start(async (events: readonly AgentEvent[]) => {
			for (const event of events) secondEvents.push(event.type);
		});
		second.harness.resume();
		const again = await root2.submit({ type: "input", content: "", requestId: "turn:1" }, BACKGROUND_CONTEXT);
		const settled = await again.wait(BACKGROUND_CONTEXT);
		await new Promise((resolve) => setTimeout(resolve, 50));
		await stream.stop();
		expect(secondEvents).not.toContain("tool_execution_start");
		expect(secondEvents[0]).toBe("tool_execution_end");
		expect(settled.type === "input" && settled.status).toBe("done");
		expect(actions.lookups).toEqual([callId, callId]);
		await second.close();
	});

	it("fences out a parked owner that has not closed yet", async () => {
		const storageId = storageIdFor("tenant", "bot", randomUUID());
		const scripted = new ScriptedProvider();
		scripted.toolCall("run_terminal", { command: "ls" }).reply("Done.");
		const actions = new Actions();
		let parked!: () => void;
		const parkSignal = new Promise<void>((resolve) => {
			parked = resolve;
		});
		const first = await openOwner(storageId, scripted, actions, parked);
		const agent = { model: { provider: "openai", modelId: scripted.modelId }, thinkingLevel: "off" as const };
		const root = await first.harness.root(BACKGROUND_CONTEXT, { agent });
		await root.configure(agent, BACKGROUND_CONTEXT);
		const submission = await root.submit({ type: "input", content: "ls", requestId: "turn:2" }, BACKGROUND_CONTEXT);
		let firstOutcome = "pending";
		void submission.wait(BACKGROUND_CONTEXT).then(
			(record) => {
				firstOutcome = `resolved ${record.status}`;
			},
			(error: Error) => {
				firstOutcome = `rejected ${error.message}`;
			},
		);
		await parkSignal;
		const [callId] = [...actions.byCall.keys()];
		actions.byCall.get(callId!)!.result = "file.txt";
		const second = await openOwner(storageId, scripted, actions, () => {
			throw new Error("the new owner must not park");
		});
		const root2 = await second.harness.root(BACKGROUND_CONTEXT, { agent });
		second.harness.resume();
		const settled = await (await root2.submit({ type: "input", content: "", requestId: "turn:2" }, BACKGROUND_CONTEXT)).wait(
			BACKGROUND_CONTEXT,
		);
		expect(settled.type === "input" && settled.status).toBe("done");
		await expect(root.submit({ type: "input", content: "late", requestId: "late" }, BACKGROUND_CONTEXT)).rejects.toSatisfy(
			(error: unknown) => findStorageFailure(error) instanceof OwnershipLost,
		);
		expect(firstOutcome).toBe("pending");
		await first.close();
		await second.close();
	});
});
