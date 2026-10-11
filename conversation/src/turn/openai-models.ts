import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { TurnModel } from "./types.ts";

/**
 * The model every bot turn runs on in v1: OpenAI gpt-5-nano with low reasoning. Minimal reasoning skipped the
 * computer tools about one time in five on a clean conversation and four times in five once the conversation held the
 * bot's own earlier claims that it could not run code; low reasoning used them every time in both cases (five runs each).
 */
export const DEFAULT_TURN_MODEL: TurnModel = { provider: "openai", modelId: "gpt-5-nano", thinkingLevel: "low" };

/**
 * The model collection a deployed executor uses: the OpenAI provider, whose API key pi-ai reads from the
 * `OPENAI_API_KEY` environment variable.
 *
 * @returns A collection with the OpenAI provider installed.
 */
export function createOpenAiModels(): Models {
	const models = createModels();
	models.setProvider(openaiProvider());
	return models;
}
