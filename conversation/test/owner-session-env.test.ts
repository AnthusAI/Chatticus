import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { defineExtension, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { beforeAll, describe, expect, it } from "vitest";
import { ScriptedProvider } from "../features-support/fakes/scripted-provider.ts";
import { openOwnerSession } from "../src/pi/session.ts";
import { storageIdFor } from "../src/storage/storage-support.ts";
import { createPiSessionBucket, createPiSessionTable } from "../src/storage/table-definition.ts";

const endpoint = process.env.CHATTICUS_TEST_AWS_ENDPOINT ?? "http://127.0.0.1:5555";
const credentials = { accessKeyId: "test", secretAccessKey: "test" };
const client = new DynamoDBClient({ endpoint, region: "us-east-1", credentials, maxAttempts: 1 });
const s3 = new S3Client({ endpoint, region: "us-east-1", credentials, forcePathStyle: true, maxAttempts: 1 });
const tableName = "owner-session-env";
const bucket = "owner-session-env";

beforeAll(async () => {
	await createPiSessionTable(client, tableName);
	await createPiSessionBucket(s3, bucket);
});

describe("the execution environment of an owner session", () => {
	it("reaches the tools of an owner that is given one and is absent for an owner that is not", async () => {
		const seen: Array<string | undefined> = [];
		const probe = defineTool({
			name: "probe_environment",
			description: "Report the working directory of the execution environment.",
			parameters: Type.Object({}),
			replay: "safe",
			execute: async (_args, api) => {
				seen.push(api.env?.cwd);
				return { content: [{ type: "text", text: "probed" }] };
			},
		}) as unknown as ToolRegistration;
		const extension = defineExtension({ name: "probe", tools: [probe] });
		for (const env of [() => new NodeExecutionEnv({ cwd: "/tmp" }), undefined]) {
			const scripted = new ScriptedProvider();
			scripted.toolCall("probe_environment", {}).reply("Done.");
			const models = createModels();
			models.setProvider(scripted.provider);
			const session = await openOwnerSession(storageIdFor("tenant", "bot", randomUUID()), {
				client,
				s3,
				tableName,
				bucket,
				models,
				extensions: [extension],
				context: BACKGROUND_CONTEXT,
				settings: { retry: { maxRetries: 0, baseDelayMs: 1 } },
				env,
			});
			const agent = { model: { provider: "openai", modelId: scripted.modelId }, thinkingLevel: "off" as const };
			const root = await session.harness.root(BACKGROUND_CONTEXT, { agent });
			await root.configure(agent, BACKGROUND_CONTEXT);
			await (await root.submit({ type: "input", content: "probe", requestId: "turn:1" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
			await session.close();
		}
		expect(seen).toEqual(["/tmp", undefined]);
	}, 30_000);
});
