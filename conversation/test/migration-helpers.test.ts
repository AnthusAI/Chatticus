import { describe, expect, it } from "vitest";
import { MIGRATED_MODEL, MIGRATED_PROVIDER, migratedAssistantMessage, migrationRequestId } from "../src/migration/copy.ts";
import { type MigrationDependencies } from "../src/migration/copy.ts";
import { runMigrationCli } from "../src/migration/cli.ts";
import { transcriptChecksum, type LegacyMessage } from "../src/migration/legacy-layout.ts";
import { markerKey } from "../src/migration/migration-state.ts";

const message = (overrides: Partial<LegacyMessage> = {}): LegacyMessage => ({
	tenantId: "t",
	channelId: "c",
	seq: 1,
	messageId: "m1",
	authorKind: "human",
	authorId: "ryan",
	body: "hello",
	addressedToBotId: null,
	createdAt: "2026-09-01T09:00:05.123456+00:00",
	...overrides,
});

describe("transcriptChecksum", () => {
	it("changes when a body, a sequence, the order or the count changes", () => {
		const base = transcriptChecksum([message(), message({ seq: 2, messageId: "m2" })]);
		expect(transcriptChecksum([message(), message({ seq: 2, messageId: "m2" })])).toBe(base);
		expect(transcriptChecksum([message({ body: "hullo" }), message({ seq: 2, messageId: "m2" })])).not.toBe(base);
		expect(transcriptChecksum([message({ seq: 3 }), message({ seq: 2, messageId: "m2" })])).not.toBe(base);
		expect(transcriptChecksum([message({ seq: 2, messageId: "m2" }), message()])).not.toBe(base);
		expect(transcriptChecksum([message()])).not.toBe(base);
	});
});

describe("migratedAssistantMessage", () => {
	it("is a stopped, zero-usage assistant message from the migrated model with the original time", () => {
		const migrated = migratedAssistantMessage(message({ authorKind: "bot", authorId: "ada", body: "done" }));
		expect(migrated).toMatchObject({
			role: "assistant",
			provider: MIGRATED_PROVIDER,
			model: MIGRATED_MODEL,
			stopReason: "stop",
			content: [{ type: "text", text: "done" }],
			timestamp: Date.parse("2026-09-01T09:00:05.123Z"),
		});
		expect(migrated.usage).toMatchObject({ input: 0, output: 0, totalTokens: 0 });
	});

	it("refuses a message whose time is not a timestamp", () => {
		expect(() => migratedAssistantMessage(message({ createdAt: "yesterday" }))).toThrow(/not a timestamp/);
	});
});

describe("keys", () => {
	it("names the marker per tenant, bot and channel and the request per message", () => {
		expect(markerKey("t", "ada", "c")).toEqual({ pk: "MIGRATED#t#ada#c", sk: "marker" });
		expect(migrationRequestId("m1")).toBe("migrate:m1");
	});
});

describe("runMigrationCli arguments", () => {
	const neverBuilt = {
		build: (): MigrationDependencies => {
			throw new Error("the stores must not be opened for a usage error");
		},
	};

	it("prints usage and exits 2 without a command", async () => {
		const result = await runMigrationCli([], neverBuilt);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("usage: migrate-transcripts");
	});

	it("exits 2 for an unknown command and for an unknown environment", async () => {
		expect((await runMigrationCli(["explode", "--environment", "development"], neverBuilt)).exitCode).toBe(2);
		const unknownEnvironment = await runMigrationCli(["copy", "--environment", "qa"], neverBuilt);
		expect(unknownEnvironment.exitCode).toBe(2);
		expect(unknownEnvironment.stderr).toContain("--environment must be one of");
	});
});
