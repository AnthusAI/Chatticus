import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { describe, expect, it } from "vitest";
import { ScriptedProvider } from "../features-support/fakes/scripted-provider.ts";
import {
	isFillerOnly,
	ModelUserUnderstanding,
	understandingIsTrusted,
	understandingPrompt,
	understoodTextFromReply,
	UNDERSTANDING_SYSTEM_PROMPT,
} from "../src/voice/understanding.ts";

function modelsServing(scripted: ScriptedProvider) {
	const models = createModels();
	models.setProvider(scripted.provider);
	return models;
}

describe("filler decision", () => {
	it("calls a line of only filler tokens filler", () => {
		expect(isFillerOnly("um uh hmm")).toBe(true);
		expect(isFillerOnly("Uh, um... HMM")).toBe(true);
		expect(isFillerOnly("   ")).toBe(true);
	});

	it("never calls real words or punctuation alone filler", () => {
		expect(isFillerOnly("check build")).toBe(false);
		expect(isFillerOnly("um check the build")).toBe(false);
		expect(isFillerOnly("...")).toBe(false);
	});
});

describe("trust rule", () => {
	it("trusts a repair of about the same size", () => {
		expect(understandingIsTrusted("ping tell me some thing", "Ping, tell me something.")).toBe(true);
	});

	it("does not trust more than two extra words or 1.5 times the length plus twenty characters", () => {
		expect(understandingIsTrusted("yes", "Yes, and also delete every branch.")).toBe(false);
		expect(understandingIsTrusted("a b", "a b c d")).toBe(true);
		expect(understandingIsTrusted("a b", "a b c d e")).toBe(false);
	});
});

describe("prompt", () => {
	it("fences the conversation and the transcript and caps each recent line at 500 characters", () => {
		const prompt = understandingPrompt("hello there", [{ speaker: "Person", text: "x".repeat(600) }]);
		expect(prompt).toBe(`<conversation>\nPerson: ${"x".repeat(500)}\n</conversation>\n\n<transcript>\nhello there\n</transcript>`);
	});

	it("says none when there is no conversation", () => {
		expect(understandingPrompt("hi", [])).toContain("<conversation>\n(none)\n</conversation>");
	});
});

describe("reply parsing", () => {
	it("takes the understood text, trimmed", () => {
		expect(understoodTextFromReply('{"understood": "  Hi.  "}')).toBe("Hi.");
	});

	it("rejects a reply without understood", () => {
		expect(() => understoodTextFromReply('{"other": 1}')).toThrow("missing 'understood'");
		expect(() => understoodTextFromReply("not json")).toThrow();
	});
});

describe("one-shot completion through the faux provider", () => {
	it("returns the parsed text and the usage the provider reported", async () => {
		const scripted = new ScriptedProvider("openai", "gpt-5-nano").reply('{"understood":"Status, please."}', { input: 300, output: 12 });
		const understanding = new ModelUserUnderstanding(modelsServing(scripted));
		const result = await understanding.understand("status please", [{ speaker: "Person", text: "earlier" }]);
		expect(result.text).toBe("Status, please.");
		expect(result.usage).toEqual({ vendor: "openai", model: "gpt-5-nano", inputTokens: 300, outputTokens: 12 });
		expect(scripted.callCount).toBe(1);
		expect(scripted.requests[0]).toContain("<transcript>\\nstatus please\\n</transcript>");
		expect(scripted.requests[0]).toContain("Person: earlier");
	});

	it("rejects when the provider fails", async () => {
		const scripted = new ScriptedProvider("openai", "gpt-5-nano").providerError(500, "server_error");
		await expect(new ModelUserUnderstanding(modelsServing(scripted)).understand("hi", [])).rejects.toThrow("500");
	});

	it("rejects when the reply is not the expected JSON", async () => {
		const scripted = new ScriptedProvider("openai", "gpt-5-nano").reply("Sure, here you go.");
		await expect(new ModelUserUnderstanding(modelsServing(scripted)).understand("hi", [])).rejects.toThrow();
	});

	it("rejects when the model is not served", async () => {
		const scripted = new ScriptedProvider("openai", "another-model");
		await expect(new ModelUserUnderstanding(modelsServing(scripted)).understand("hi", [])).rejects.toThrow("not available");
	});
});

describe("one-shot completion through the real OpenAI provider with its request intercepted", () => {
	const reply = '{"understood":"Hi."}';
	const events = [
		{ type: "response.created", response: { id: "r1", status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m1", role: "assistant", status: "in_progress", content: [] } },
		{ type: "response.content_part.added", item_id: "m1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
		{ type: "response.output_text.delta", item_id: "m1", output_index: 0, content_index: 0, delta: reply },
		{ type: "response.output_text.done", item_id: "m1", output_index: 0, content_index: 0, text: reply },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: { type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: reply, annotations: [] }] },
		},
		{
			type: "response.completed",
			response: {
				id: "r1",
				status: "completed",
				usage: { input_tokens: 30, output_tokens: 7, total_tokens: 37, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
				output: [],
			},
		},
	].map((event, index) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`);

	it("asks gpt-5-nano for a minimal-reasoning JSON object reply and reads text and usage back", async () => {
		const models = createModels();
		models.setProvider(openaiProvider());
		const model = models.getModel("openai", "gpt-5-nano");
		expect(model?.api).toBe("openai-responses");
		let sent: any = null;
		const understanding = new ModelUserUnderstanding(models);
		const originalComplete = models.completeSimple.bind(models);
		models.completeSimple = (target, context, options) =>
			originalComplete(target, context, {
				...options,
				apiKey: "not-a-real-key",
				fetch: async (url, init) => {
					sent = { url: String(url), body: JSON.parse(String((init as RequestInit).body)) };
					return new Response(events.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
				},
			});
		const result = await understanding.understand("hi", []);
		expect(result.text).toBe("Hi.");
		expect(result.usage).toEqual({ vendor: "openai", model: "gpt-5-nano", inputTokens: 30, outputTokens: 7 });
		expect(sent.url).toBe("https://api.openai.com/v1/responses");
		expect(sent.body.model).toBe("gpt-5-nano");
		expect(sent.body.reasoning.effort).toBe("minimal");
		expect(sent.body.text.format).toEqual({ type: "json_object" });
		expect(sent.body.input[0]).toEqual({ role: "developer", content: UNDERSTANDING_SYSTEM_PROMPT });
	});
});
