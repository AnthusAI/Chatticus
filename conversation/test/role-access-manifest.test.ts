import { describe, expect, it } from "vitest";
import {
	ACCESS_ROLES,
	ACCESS_STORES,
	exampleKeyOf,
	exampleRequestOf,
	exampleTagsOf,
	isBucketStore,
	loadRoleAccessManifest,
	type AccessRow,
	type StoreArns,
} from "../src/gateway/role-access-manifest.ts";

const ARNS: StoreArns = {
	messagingTable: "arn:aws:dynamodb:us-east-1:111122223333:table/messaging",
	conversationsTable: "arn:aws:dynamodb:us-east-1:111122223333:table/conversations",
	piSessionsBucket: "arn:aws:s3:::pi-sessions",
	snapshotBucket: "arn:aws:s3:::snapshots",
	channelEventBus: "arn:aws:events:us-east-1:111122223333:event-bus/default",
	rawMailBucket: "arn:aws:s3:::raw-mail",
	mailIdentity: "arn:aws:ses:us-east-1:111122223333:identity/mail.example.test",
	mailConfigurationSet: "arn:aws:ses:us-east-1:111122223333:configuration-set/outbound",
};

const rows = loadRoleAccessManifest();

describe("the role access manifest file", () => {
	it("lists rows for every role", () => {
		for (const role of ACCESS_ROLES) expect(rows.filter((row) => row.role === role).length).toBeGreaterThan(0);
	});

	it("names only known roles and stores, and an action of the service of its store", () => {
		for (const row of rows) {
			expect(ACCESS_ROLES).toContain(row.role);
			expect(ACCESS_STORES).toContain(row.store);
			const servicePrefix = isBucketStore(row.store) ? "s3:" : row.store === "channelEventBus" ? "events:" : row.store === "mailIdentity" || row.store === "mailConfigurationSet" ? "ses:" : "dynamodb:";
			expect(row.action.startsWith(servicePrefix)).toBe(true);
		}
	});

	it("gives every row an example key that its own key pattern accepts", () => {
		for (const row of rows) {
			if (row.keyPattern === "") expect(exampleKeyOf(row)).toBe("");
			else expect(new RegExp(row.keyPattern).test(exampleKeyOf(row)), `${row.role} ${row.action} ${row.exampleKey}`).toBe(true);
		}
	});

	it("lists each role, action, store, index and key pattern once", () => {
		const identities = rows.map((row) => [row.role, row.action, row.store, row.index === true, row.keyPattern].join("|"));
		expect(new Set(identities).size).toBe(identities.length);
	});

	it("marks keyAlwaysExists only on object reads, and explains each such row", () => {
		for (const row of rows.filter((candidate) => candidate.keyAlwaysExists === true)) {
			expect(row.action).toBe("s3:GetObject");
			expect(row.note, `${row.role} ${row.exampleKey} needs a note saying why the key always exists`).toBeTruthy();
		}
	});
});

describe("the request IAM sees for a manifest row", () => {
	const row = (overrides: Partial<AccessRow>): AccessRow => ({
		role: "ownerTurn",
		action: "dynamodb:GetItem",
		store: "messagingTable",
		keyPattern: "^x$",
		exampleKey: "{tenantId}#roster",
		...overrides,
	});

	it("names the table and carries the leading key for a table row", () => {
		expect(exampleRequestOf(row({}), ARNS)).toEqual({
			action: "dynamodb:GetItem",
			resourceArn: ARNS.messagingTable,
			contextKeys: { "dynamodb:LeadingKeys": ["anthus#roster"] },
		});
	});

	it("names an index resource for an index row", () => {
		expect(exampleRequestOf(row({ index: true }), ARNS).resourceArn).toBe(`${ARNS.messagingTable}/index/example`);
	});

	it("names the object and carries no condition key for an object row", () => {
		const request = exampleRequestOf(row({ action: "s3:GetObject", store: "snapshotBucket", exampleKey: "tenants/{tenantId}/computers/{computerId}/manifest.json" }), ARNS);
		expect(request).toEqual({ action: "s3:GetObject", resourceArn: "arn:aws:s3:::snapshots/tenants/anthus/computers/computer-1/manifest.json", contextKeys: {} });
	});

	it("names the bucket and carries the prefix for a listing row", () => {
		const request = exampleRequestOf(row({ action: "s3:ListBucket", store: "piSessionsBucket", exampleKey: "conversations/{tenantId}%23{botId}%23{channelId}/" }), ARNS);
		expect(request).toEqual({ action: "s3:ListBucket", resourceArn: ARNS.piSessionsBucket, contextKeys: { "s3:prefix": ["conversations/anthus%23bot-1%23channel-1/"] } });
	});

	it("carries the tags the role is assumed with, and none for the Front Door", () => {
		expect(exampleTagsOf("frontDoor")).toEqual({});
		expect(exampleTagsOf("supervisor")).toEqual({ tenant: "anthus", computer: "computer-1" });
		expect(exampleTagsOf("ownerTurn")).toEqual({ tenant: "anthus", bot: "bot-1", channel: "channel-1", computer: "computer-1", turn: "turn-1" });
	});
});
