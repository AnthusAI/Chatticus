import { describe, expect, it } from "vitest";
import { applyExactEdit } from "@chatticus/host-protocol/workspace-edit";

describe("applyExactEdit", () => {
	it("replaces the one occurrence of the old text", () => {
		expect(applyExactEdit("alpha beta gamma", "beta", "delta", "/workspace/a.txt")).toEqual({ ok: true, content: "alpha delta gamma" });
	});

	it("matches across lines and keeps every other line", () => {
		const result = applyExactEdit("one\ntwo\nthree\n", "two\nthree", "2\n3", "/workspace/a.txt");
		expect(result).toEqual({ ok: true, content: "one\n2\n3\n" });
	});

	it("refuses text that is not found and says the match must be exact", () => {
		const result = applyExactEdit("alpha", "Alpha", "x", "/workspace/a.txt");
		expect(result).toEqual({
			ok: false,
			message: "Could not find the exact text in /workspace/a.txt. The old text must match exactly including all whitespace and newlines.",
		});
	});

	it("refuses text that occurs more than once and asks for more context", () => {
		const result = applyExactEdit("one two one", "one", "1", "/workspace/a.txt");
		expect(result).toEqual({
			ok: false,
			message: "Found 2 occurrences of the text in /workspace/a.txt. The text must be unique. Please provide more context to make it unique.",
		});
	});

	it("refuses empty old text", () => {
		expect(applyExactEdit("alpha", "", "x", "/workspace/a.txt")).toEqual({ ok: false, message: "old_text must not be empty in /workspace/a.txt." });
	});

	it("refuses a replacement that changes nothing", () => {
		const result = applyExactEdit("alpha", "alpha", "alpha", "/workspace/a.txt");
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.message).toContain("No changes made to /workspace/a.txt.");
	});

	it("keeps carriage return line endings and the byte order mark", () => {
		const result = applyExactEdit("﻿one\r\ntwo\r\n", "one\ntwo", "1\n2", "/workspace/a.txt");
		expect(result).toEqual({ ok: true, content: "﻿1\r\n2\r\n" });
	});

	it("does not match fuzzily across quote or dash styles", () => {
		expect(applyExactEdit("it’s - fine", "it's - fine", "x", "/workspace/a.txt").ok).toBe(false);
	});
});
