import { describe, expect, it } from "vitest";
import { memberAuthorityCeilingFromStructuredArguments } from "../src/policy/authorization-ceiling.ts";
import { ConnectionProposalStatus } from "../src/policy/connections.ts";
import { AutoReviewRuleKind, humanIdentity, sortedBindingPairs } from "../src/policy/models.ts";
import * as approvalCodec from "../src/store/codecs/approval.ts";
import * as connectionCodec from "../src/store/codecs/connection.ts";
import * as ruleCodec from "../src/store/codecs/rule.ts";
import * as standingCodec from "../src/store/codecs/standing.ts";

describe("policy item codecs", () => {
	it("keys approvals under the tenant approvals partition", () => {
		const item = approvalCodec.encode({
			approvalId: "a1",
			tenantId: "anthus",
			kind: "approval",
			actionType: "send",
			destination: "alex@example.com",
			payload: "hello",
			approverKind: "human",
			approverId: "ryan",
		});
		expect(item.pk.S).toBe("anthus#approvals");
		expect(item.sk.S).toBe("APPROVAL#a1");
		expect(approvalCodec.decode(item)).toEqual({
			approvalId: "a1",
			tenantId: "anthus",
			kind: "approval",
			actionType: "send",
			destination: "alex@example.com",
			payload: "hello",
			approverKind: "human",
			approverId: "ryan",
		});
	});

	it("round-trips a rule with bindings and a creator", () => {
		const rule = {
			ruleId: "r1",
			kind: AutoReviewRuleKind.AlwaysAllow,
			actionType: "send",
			tenantId: "anthus",
			userId: null,
			argumentBindings: sortedBindingPairs({ recipient: "alex@example.com", body: "hello" }),
			creator: humanIdentity("ryan"),
		};
		const item = ruleCodec.encode(rule);
		expect(item.pk.S).toBe("anthus#rules");
		expect(item.sk.S).toBe("RULE#r1");
		expect(ruleCodec.decode(item)).toEqual(rule);
	});

	it("round-trips a connection record with and without a clip", () => {
		const proposal = {
			proposalId: "p1",
			grantingTenantId: "anthus",
			receivingTenantId: "partner",
			channelId: "c1",
			channelName: "support-queue",
			permission: "read",
			proposerUserId: "sam",
		};
		const pending = { proposal, status: null, escalationTargetUserId: null, authorized: null };
		const pendingItem = connectionCodec.encode(pending);
		expect(pendingItem.pk.S).toBe("anthus#connections");
		expect(pendingItem.sk.S).toBe("CONN#p1");
		expect(connectionCodec.decode(pendingItem)).toEqual(pending);

		const authorized = {
			proposal,
			status: ConnectionProposalStatus.Authorized,
			escalationTargetUserId: null,
			authorized: {
				connectionId: "k1",
				grantingTenantId: "anthus",
				receivingTenantId: "partner",
				channelId: "c1",
				channelName: "support-queue",
				permission: "read",
				clippedByUserId: "sam",
				createdAt: new Date("2026-08-31T12:00:00Z"),
			},
		};
		expect(connectionCodec.decode(connectionCodec.encode(authorized))).toEqual(authorized);
	});

	it("round-trips a member standing ceiling", () => {
		const ceiling = memberAuthorityCeilingFromStructuredArguments("send", {
			recipient: "alex@example.com",
			body: "weekly update",
		});
		const item = standingCodec.encodeMemberCeiling("anthus", "sam", "send", ceiling);
		expect(item.sk.S).toBe("CEILING#sam#send");
		expect(standingCodec.decodeCeiling(item)).toEqual(ceiling);
	});

	it("round-trips a refusal", () => {
		const refusal = {
			refusalId: "f1",
			tenantId: "anthus",
			kind: "authority_ceiling" as const,
			fields: ["anthus", "send", "sam"],
		};
		expect(ruleCodec.decodeRefusal(ruleCodec.encodeRefusal(refusal))).toEqual(refusal);
	});
});
