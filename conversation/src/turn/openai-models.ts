import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { TurnModel } from "./types.ts";

/** The model every bot turn runs on in v1: OpenAI gpt-5-nano with minimal reasoning. */
export const DEFAULT_TURN_MODEL: TurnModel = { provider: "openai", modelId: "gpt-5-nano", thinkingLevel: "minimal" };

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
