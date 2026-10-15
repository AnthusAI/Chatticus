/**
 * Codec contract test: encode/decode round-trip and exact attribute matching.
 * Fixtures are golden JSON generated once from Python and frozen in the repo.
 * This test ensures TypeScript codecs stay byte-for-byte compatible with Python.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import * as botCodec from "../src/store/codecs/bot.ts";
import * as computerCodec from "../src/store/codecs/computer.ts";
import * as identityCodec from "../src/store/codecs/identity.ts";
import * as idempotencyCodec from "../src/store/codecs/idempotency.ts";
import * as invitationCodec from "../src/store/codecs/invitation.ts";
import * as membershipCodec from "../src/store/codecs/membership.ts";
import * as organizationCodec from "../src/store/codecs/organization.ts";
import * as taskCodec from "../src/store/codecs/task.ts";
import * as workerCodec from "../src/store/codecs/worker.ts";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";

const fixturesDir = join(__dirname, "fixtures", "items");

function loadFixture(kind: string): Record<string, AttributeValue> {
	const path = join(fixturesDir, `${kind}.json`);
	const content = readFileSync(path, "utf-8");
	return JSON.parse(content);
}

describe("codecs contract tests", () => {
	describe("identity", () => {
		it("round-trips through encode/decode", () => {
			const fixture = loadFixture("identity");
			const decoded = identityCodec.decode(fixture);
			const reencoded = identityCodec.encode(decoded);
			expect(reencoded).toEqual(fixture);
		});

		it("decodes fixture to expected shape", () => {
			const fixture = loadFixture("identity");
			const decoded = identityCodec.decode(fixture);
			expect(decoded).toEqual({
				userId: "user-123",
				email: "alice@example.com",
				createdAt: new Date("2024-01-15T10:30:00+00:00"),
			});
		});
	});

	describe("organization", () => {
		it("round-trips through encode/decode", () => {
			const fixture = loadFixture("organization");
			const decoded = organizationCodec.decode(fixture);
			const reencoded = organizationCodec.encode(decoded);
			expect(reencoded).toEqual(fixture);
		});

		it("decodes fixture to expected shape", () => {
			const fixture = loadFixture("organization");
			const decoded = organizationCodec.decode(fixture);
			expect(decoded.tenantId).toBe("org-456");
			expect(decoded.name).toBe("Acme Corp");
			expect(decoded.status).toBe("enabled");
			expect(decoded.ownerUserId).toBe("user-123");
			expect(decoded.awsAccountId).toBe("123456789012");
			expect(decoded.setupFeeCents).toBe(5000);
			expect(decoded.assistedSetupSession).toBe(true);
			expect(decoded.monthlyAwsSpendCeilingUsd).toBe("1000.00");
		});
	});

	describe("membership", () => {
		it("round-trips through encode/decode", () => {
			const fixture = loadFixture("membership");
			const decoded = membershipCodec.decode(fixture);
			const reencoded = membershipCodec.encode(decoded);
			expect(reencoded).toEqual(fixture);
		});

		it("decodes fixture to expected shape", () => {
			const fixture = loadFixture("membership");
			const decoded = membershipCodec.decode(fixture);
			expect(decoded).toEqual({
				tenantId: "org-456",
				userId: "user-123",
				role: "owner",
				joinedAt: new Date("2024-01-15T10:30:00+00:00"),
			});
		});
	});

	describe("invitation", () => {
		it("round-trips through encode/decode", () => {
			const fixture = loadFixture("invitation");
			const decoded = invitationCodec.decode(fixture);
			const reencoded = invitationCodec.encode(decoded);
			expect(reencoded).toEqual(fixture);
		});

		it("decodes fixture to expected shape", () => {
			const fixture = loadFixture("invitation");
			const decoded = invitationCodec.decode(fixture);
			expect(decoded.invitationId).toBe("inv-789");
			expect(decoded.tenantId).toBe("org-456");
			expect(decoded.email).toBe("bob@example.com");
			expect(decoded.invitedByUserId).toBe("user-123");
			expect(decoded.role).toBe("member");
			expect(decoded.status).toBe("pending");
			expect(decoded.expiresAt).toEqual(new Date(1707993000 * 1000));
			expect(decoded.createdAt).toEqual(new Date("2024-01-15T10:30:00+00:00"));
		});
	});

	describe("worker", () => {
		it("round-trips through encode/decode", () => {
			const fixture = loadFixture("worker");
			const decoded = workerCodec.decode(fixture);
			const reencoded = workerCodec.encode(decoded);
			expect(reencoded).toEqual(fixture);
		});

		it("decodes fixture to expected shape", () => {
			const fixture = loadFixture("worker");
			const decoded = workerCodec.decode(fixture);
			expect(decoded.workerId).toBe("worker-abc");
			expect(decoded.tenantId).toBe("org-456");
			expect(decoded.costClass).toBe("ec2");
			expect(decoded.capabilities).toEqual(["computer", "shell"]);
			expect(decoded.tokenHash).toBe("sha256:abc123def456");
			expect(decoded.lastHeartbeatAt).toEqual(new Date("2024-01-15T10:30:00+00:00"));
			expect(decoded.computerId).toBe("comp-xyz");
			expect(decoded.hydratedSnapshotGeneration).toBe(5);
		});
	});

	describe("computer", () => {
		it("round-trips through encode/decode", () => {
			const fixture = loadFixture("computer");
			const decoded = computerCodec.decode(fixture);
			const reencoded = computerCodec.encode(decoded);
			expect(reencoded).toEqual(fixture);
		});

		it("decodes fixture to expected shape", () => {
			const fixture = loadFixture("computer");
			const decoded = computerCodec.decode(fixture);
			expect(decoded.computerId).toBe("comp-xyz");
			expect(decoded.tenantId).toBe("org-456");
			expect(decoded.policy).toBe("prefer_local");
			expect(decoded.stopped).toBe(false);
			expect(decoded.modelReady).toBe(true);
			expect(decoded.workspaceReady).toBe(true);
			expect(decoded.browserReady).toBe(false);
			expect(decoded.hostStartGeneration).toBe(2);
			expect(decoded.hostStartDispatchedGeneration).toBe(1);
			expect(decoded.snapshotGeneration).toBe(3);
			expect(decoded.diskDirty).toBe(false);
			expect(decoded.hydrateRequired).toBe(false);
			expect(decoded.hostStartLeaseExpiresAt).toEqual(new Date(1705321800 * 1000));
			expect(decoded.snapshotUri).toBe("s3://bucket/snap.tar.gz");
			expect(decoded.snapshotChecksum).toBe("sha256:xyz789");
			expect(decoded.intendedHostWorkerId).toBe("worker-abc");
			expect(decoded.browserUnavailable).toBeUndefined();
		});

		it("round-trips the browser unavailable report and leaves it out when absent", () => {
			const decoded = computerCodec.decode(loadFixture("computer"));
			const unavailable = computerCodec.encode({ ...decoded, browserUnavailable: true });
			expect(unavailable.browser_unavailable).toEqual({ BOOL: true });
			expect(computerCodec.decode(unavailable).browserUnavailable).toBe(true);
			expect(computerCodec.encode(decoded).browser_unavailable).toBeUndefined();
		});
	});

	describe("bot", () => {
		it("round-trips through encode/decode", () => {
			const fixture = loadFixture("bot");
			const decoded = botCodec.decode(fixture);
			const reencoded = botCodec.encode(decoded);
			expect(reencoded).toEqual(fixture);
		});

		it("decodes fixture to expected shape", () => {
			const fixture = loadFixture("bot");
			const decoded = botCodec.decode(fixture);
			expect(decoded.botId).toBe("bot-def");
			expect(decoded.tenantId).toBe("org-456");
			expect(decoded.name).toBe("Assistant");
			expect(decoded.memory).toEqual({
				context: "user preferences",
				history: "last 10 turns",
			});
		});
	});

	describe("task", () => {
		it("round-trips through encode/decode", () => {
			const fixture = loadFixture("task");
			const decoded = taskCodec.decode(fixture);
			const reencoded = taskCodec.encode(decoded);
			expect(reencoded).toEqual(fixture);
		});

		it("decodes fixture to expected shape", () => {
			const fixture = loadFixture("task");
			const decoded = taskCodec.decode(fixture);
			expect(decoded.taskId).toBe("task-ghi");
			expect(decoded.tenantId).toBe("org-456");
			expect(decoded.userId).toBe("user-123");
			expect(decoded.title).toBe("Fix the bug");
			expect(decoded.status).toBe("open");
			expect(decoded.evidence).toBe("Test case 42 passes");
			expect(decoded.createdByBotId).toBe("bot-def");
			expect(decoded.updatedByBotId).toBeUndefined();
		});
	});

	describe("idempotency", () => {
		it("round-trips through encode/decode", () => {
			const fixture = loadFixture("idempotency");
			const decoded = idempotencyCodec.decode(fixture);
			const reencoded = idempotencyCodec.encode(decoded);
			expect(reencoded).toEqual(fixture);
		});

		it("decodes fixture to expected shape", () => {
			const fixture = loadFixture("idempotency");
			const decoded = idempotencyCodec.decode(fixture);
			expect(decoded.pk).toBe("org-456#roster");
			expect(decoded.sk).toBe("idem#post-123");
			expect(decoded.tenantId).toBe("org-456");
			expect(decoded.channelId).toBe("ch-001");
			expect(decoded.messageId).toBe("msg-001");
			expect(decoded.seq).toBe(1);
			expect(decoded.authorKind).toBe("user");
			expect(decoded.authorId).toBe("user-123");
			expect(decoded.body).toBe("Hello world");
			expect(decoded.addressedToBotId).toBeUndefined();
			expect(decoded.createdAt).toBe("2024-01-15T10:30:00");
			expect(decoded.turnId).toBe("turn-456");
		});
	});
});
