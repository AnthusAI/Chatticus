import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { TurnModel } from "./types.ts";

/**
 * The model every bot turn runs on in v1: OpenAI gpt-6-luna with low reasoning. pi-ai 1.0.2 already lists the model
 * (api openai-responses, text and image input, reasoning levels none through max with no minimal), so no custom model
 * is defined. On the real channel Luna answered plain text to a greeting and used the computer tool in six of six trials.
 */
export const DEFAULT_TURN_MODEL: TurnModel = { provider: "openai", modelId: "gpt-6-luna", thinkingLevel: "low" };

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
