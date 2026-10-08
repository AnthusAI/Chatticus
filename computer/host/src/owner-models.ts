import { createModels, createProvider, type Models } from "@earendil-works/pi-ai/models";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

/**
 * Where the container owner sends model requests: the control plane's model gateway, never the vendor. The container holds
 * the gateway's per-session token and nothing of the vendor's key. The gateway itself is not part of this program; a
 * deployment injects its address and the token it issued for the turn.
 */
export type ModelGatewayConfig = {
	/** The gateway's address in place of the vendor's API address, for example `https://gateway.example/v1`. */
	readonly baseUrl: string;
	/** The token sent in place of the vendor key. It is bound by the gateway to one tenant, bot and turn. */
	readonly token: string;
};

/**
 * The model collection of a container owner: the OpenAI chat models the Lambda owner uses, with every request pointed at
 * the gateway and authenticated by the injected token.
 *
 * @param gateway The gateway address and token.
 * @returns A collection whose only provider reaches the gateway.
 */
export function createGatewayModels(gateway: ModelGatewayConfig): Models {
	const vendor = openaiProvider();
	const models = createModels();
	models.setProvider(
		createProvider({
			id: "openai",
			name: "Chatticus model gateway",
			baseUrl: gateway.baseUrl,
			auth: {
				apiKey: {
					name: "Model gateway token",
					resolve: async ({ signal }) => {
						signal.throwIfAborted();
						return { auth: { apiKey: gateway.token }, source: "model gateway token" };
					},
				},
			},
			models: vendor.getModels().map((model) => ({ ...model, baseUrl: gateway.baseUrl })),
			api: openAIResponsesApi(),
		}),
	);
	return models;
}
