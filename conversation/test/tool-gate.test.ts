import { describe, expect, it } from "vitest";
import { APPROVAL_REQUIRED_REASON, evaluateModelToolRequest, requestedCapabilityForModelTool } from "../src/pi/gate.ts";
import { MemberStanding } from "../src/policy/authorization-ceiling.ts";
import { householdConversationGrant, parseGrantTable } from "../src/policy/capability-policy.ts";
import { decodeGrant, encodeGrant, encodeGrantText } from "../src/store/codecs/grant.ts";

const gateFor = (grant = householdConversationGrant()) => ({
	now: () => new Date("2026-10-05T00:00:00Z"),
	readGrant: async () => grant,
	resolveStanding: async () => MemberStanding.owner(),
});

describe("requestedCapabilityForModelTool", () => {
	it("maps a terminal call without a working directory to /workspace", () => {
		expect(requestedCapabilityForModelTool("run_terminal", { command: "ls" }).filePath).toBe("/workspace");
	});

	it("maps browse to an origin fetch of the url", () => {
		const request = requestedCapabilityForModelTool("browse", { url: "https://docs.example.com/a" });
		expect(request.origin).toBe("https://docs.example.com/a");
		expect(request.egressClass).toBe("approved_origin_fetch");
	});

	it("maps an unknown tool to a request for the tool alone", () => {
		expect(requestedCapabilityForModelTool("anything_else", { a: "b" }).tool).toBe("anything_else");
	});
});

describe("evaluateModelToolRequest", () => {
	it("allows a workspace read under the conversation grant", async () => {
		expect(await evaluateModelToolRequest(gateFor(), "read_workspace", { path: "/workspace/a.txt" })).toEqual({ allowed: true });
	});

	it("denies a tool the grant does not name", async () => {
		const verdict = await evaluateModelToolRequest(gateFor(), "run_terminal", { command: "ls" });
		expect(verdict).toEqual({ allowed: false, reason: 'tool "run_terminal" is not granted' });
	});

	it("denies every tool when the turn carries no grant", async () => {
		const gate = { ...gateFor(), readGrant: async () => null };
		expect(await evaluateModelToolRequest(gate, "read_workspace", { path: "/workspace/a.txt" })).toEqual({
			allowed: false,
			reason: "no task grant",
		});
	});

	it("asks for approval of a granted consequential tool", async () => {
		const grant = parseGrantTable({
			tools: "send",
			recipients: "alex@example.com",
			egress_classes: "structured_send",
		});
		expect(await evaluateModelToolRequest(gateFor(grant), "send", { recipient: "alex@example.com", body: "hi" })).toEqual({
			allowed: false,
			reason: APPROVAL_REQUIRED_REASON,
		});
	});
});

describe("turn grant item", () => {
	it("stores compact JSON with sorted keys, as Python did", () => {
		expect(encodeGrantText(householdConversationGrant())).toBe(
			'{"egress_classes":["approved_origin_fetch"],"file_scopes":["/workspace"],"ingest_classes":[],"origins":[],"recipients":[],"tools":["read_workspace","write_workspace"]}',
		);
	});

	it("round-trips through its item", () => {
		const item = encodeGrant("anthus", "turn-1", householdConversationGrant());
		expect(item.pk).toEqual({ S: "anthus#turn#turn-1" });
		expect(item.sk).toEqual({ S: "grant" });
		expect(encodeGrantText(decodeGrant(item))).toBe(encodeGrantText(householdConversationGrant()));
	});
});
