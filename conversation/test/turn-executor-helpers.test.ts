import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Decimal } from "../src/budget/decimal.ts";
import { costUsdFromTokens } from "../src/ledger/vendor-ledger.ts";
import { CommitOutcomeUnknown, findStorageFailure, OwnershipLost } from "../src/pi/errors.ts";
import {
	ACCESS_DENIED_REASON,
	classifyModelFailure,
	GENERIC_FAILURE_REASON,
	INVALID_REQUEST_REASON,
	OUT_OF_QUOTA_REASON,
	REJECTED_KEY_REASON,
} from "../src/turn/classify-errors.ts";
import { TokenCoalescer } from "../src/turn/coalescer.ts";
import { createOpenAiModels, DEFAULT_TURN_MODEL } from "../src/turn/openai-models.ts";
import { buildSystemPrompt, COMPUTER_GUIDANCE_LINES } from "../src/turn/prompt.ts";

const providerText = (status: number, code: string): string =>
	`OpenAI API error (${status}): ${JSON.stringify({ message: "m", type: code, param: null, code })}`;

describe("classifyModelFailure", () => {
	it("maps the permanent provider errors to readable reasons", () => {
		expect(classifyModelFailure(providerText(429, "insufficient_quota"))).toBe(OUT_OF_QUOTA_REASON);
		expect(classifyModelFailure(providerText(401, "invalid_api_key"))).toBe(REJECTED_KEY_REASON);
		expect(classifyModelFailure(providerText(403, "model_access_denied"))).toBe(ACCESS_DENIED_REASON);
		expect(classifyModelFailure(providerText(400, "unsupported_value"))).toBe(INVALID_REQUEST_REASON);
		expect(classifyModelFailure(providerText(400, "invalid_request_error"))).toBe(INVALID_REQUEST_REASON);
		expect(classifyModelFailure(providerText(404, "model_not_found"))).toBe(INVALID_REQUEST_REASON);
	});

	it("treats a bare 401 as a rejected key", () => {
		expect(classifyModelFailure("401 Incorrect API key provided")).toBe(REJECTED_KEY_REASON);
	});

	it("gives everything else the generic reason, including a status with no error body", () => {
		expect(classifyModelFailure(providerText(429, "rate_limit_exceeded"))).toBe(GENERIC_FAILURE_REASON);
		expect(classifyModelFailure(providerText(503, "overloaded"))).toBe(GENERIC_FAILURE_REASON);
		expect(classifyModelFailure("403 status code (no body)")).toBe(GENERIC_FAILURE_REASON);
		expect(classifyModelFailure("Connection error.")).toBe(GENERIC_FAILURE_REASON);
		expect(classifyModelFailure(undefined)).toBe(GENERIC_FAILURE_REASON);
		expect(classifyModelFailure({ message: "odd" })).toBe(GENERIC_FAILURE_REASON);
	});
});

describe("TokenCoalescer", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const coalescerOver = (written: string[], flushBytes = 200, flushMilliseconds = 250) =>
		new TokenCoalescer({
			flushBytes,
			flushMilliseconds,
			write: async (text) => {
				written.push(text);
			},
		});

	it("writes small fragments together once the interval passes", async () => {
		const written: string[] = [];
		const coalescer = coalescerOver(written);
		coalescer.push("Hel");
		coalescer.push("lo");
		expect(written).toEqual([]);
		await vi.advanceTimersByTimeAsync(250);
		expect(written).toEqual(["Hello"]);
	});

	it("writes at once when the buffer reaches the byte threshold", async () => {
		const written: string[] = [];
		const coalescer = coalescerOver(written, 10);
		coalescer.push("12345");
		coalescer.push("67890");
		await coalescer.flush();
		expect(written).toEqual(["1234567890"]);
	});

	it("counts bytes, not characters", async () => {
		const written: string[] = [];
		const coalescer = coalescerOver(written, 4);
		coalescer.push("éé");
		await coalescer.flush();
		expect(written).toEqual(["éé"]);
	});

	it("keeps order across several writes and flushes the remainder on demand", async () => {
		const written: string[] = [];
		const coalescer = coalescerOver(written, 3);
		for (const piece of ["a", "b", "c", "d", "e"]) coalescer.push(piece);
		await coalescer.flush();
		expect(written).toEqual(["abc", "de"]);
	});

	it("raises a sink failure on the next flush and then recovers", async () => {
		let failing = true;
		const coalescer = new TokenCoalescer({
			flushBytes: 1,
			flushMilliseconds: 250,
			write: async () => {
				if (failing) throw new Error("sink down");
			},
		});
		coalescer.push("x");
		await expect(coalescer.flush()).rejects.toThrow("sink down");
		failing = false;
		coalescer.push("y");
		await expect(coalescer.flush()).resolves.toBeUndefined();
	});
});

describe("findStorageFailure", () => {
	it("finds the failure Pi hides behind a poisoned session", () => {
		const unknown = new CommitOutcomeUnknown("unknown");
		const poisoned = new Error("Session is poisoned by a failed commit after storage admission; reopen it", { cause: unknown });
		expect(findStorageFailure(poisoned)).toBe(unknown);
		expect(findStorageFailure(unknown)).toBe(unknown);
		const lost = new OwnershipLost("lost");
		expect(findStorageFailure(new Error("outer", { cause: lost }))).toBe(lost);
	});

	it("finds nothing in an unrelated error", () => {
		expect(findStorageFailure(new Error("plain"))).toBeNull();
		expect(findStorageFailure("text")).toBeNull();
	});
});

describe("buildSystemPrompt", () => {
	it("renders the fixed line, the computer guidance and the memory in key order", () => {
		const guidance = COMPUTER_GUIDANCE_LINES.join("\n");
		expect(buildSystemPrompt({ botName: "Ada", memory: { zebra: "z", apple: "a" } })).toBe(
			`You are Ada, a teammate in a Chatticus conversation. Answer briefly.\n${guidance}\nmemory apple: a\nmemory zebra: z`,
		);
		expect(buildSystemPrompt({ botName: "Grace", memory: {} })).toBe(
			`You are Grace, a teammate in a Chatticus conversation. Answer briefly.\n${guidance}`,
		);
	});

	it("tells the model that /workspace persists and is shared, what is installed, which edit tool to prefer and to try a command before refusing", () => {
		const prompt = buildSystemPrompt({ botName: "Ada", memory: {} });
		expect(prompt).toContain("/workspace folder is a persistent workspace that all teammates share");
		expect(prompt).toContain("Git and a C toolchain (gcc, g++, make) are installed");
		expect(prompt).toContain("compile and run it with run_terminal");
		expect(prompt).toContain("try it with run_terminal and tell the user what happened");
		expect(prompt).toContain("To change an existing file, use edit_workspace. To create a new file, use write_workspace.");
	});
});

describe("costUsdFromTokens", () => {
	const price = (text: string) => Decimal.parse(text);

	it("prices tokens at frozen per-million rates", () => {
		expect(costUsdFromTokens(10, 5, price("2.00"), price("4.00"))?.toString()).toBe("0.00004000");
		expect(costUsdFromTokens(3, 2, price("2.00"), price("4.00"))?.toString()).toBe("0.00001400");
	});

	it("is null without a rate or without tokens", () => {
		expect(costUsdFromTokens(10, 5, null, price("4.00"))).toBeNull();
		expect(costUsdFromTokens(0, 0, price("2.00"), price("4.00"))).toBeNull();
	});
});

describe("createOpenAiModels", () => {
	it("serves the model the bots run on", () => {
		const models = createOpenAiModels();
		expect(models.getModel(DEFAULT_TURN_MODEL.provider, DEFAULT_TURN_MODEL.modelId)).toBeDefined();
		expect(DEFAULT_TURN_MODEL).toEqual({ provider: "openai", modelId: "gpt-5-nano", thinkingLevel: "minimal" });
	});
});
