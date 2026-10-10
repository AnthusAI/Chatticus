import { describe, expect, it } from "vitest";
import { errorNameOf, formatLogLine } from "../src/observability/log-line.ts";

describe("formatLogLine", () => {
	it("writes the event and plain values as key=value pairs in the given order", () => {
		expect(formatLogLine("turn_claimed", { tenant_id: "anthus", attempt: 2, ok: true })).toBe("turn_claimed tenant_id=anthus attempt=2 ok=true");
	});

	it("leaves out undefined values and writes null as none", () => {
		expect(formatLogLine("workspace_hydrated", { generation: null, reason: undefined })).toBe("workspace_hydrated generation=none");
	});

	it("quotes a value that could add a key or a line", () => {
		expect(formatLogLine("e", { value: "a b\nc=d" })).toBe('e value="a b\\nc=d"');
	});

	it("writes an empty string as an empty quoted value", () => {
		expect(formatLogLine("e", { value: "" })).toBe('e value=""');
	});
});

describe("errorNameOf", () => {
	it("returns the name and never the message", () => {
		expect(errorNameOf(Object.assign(new Error("secret detail"), { name: "AccessDenied" }))).toBe("AccessDenied");
	});

	it("returns unknown for a thrown value that is not an error", () => {
		expect(errorNameOf("text")).toBe("unknown");
	});
});
