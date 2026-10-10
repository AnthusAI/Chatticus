import { errorNameOf, type LogEmitter } from "../../../conversation/src/observability/log-line.ts";
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
	/** The invoke key the Front Door in front of the gateway requires on every request, sent in `X-Chatticus-Invoke-Key`. */
	readonly invokeKey?: string;
};

const INVOKE_KEY_HEADER = "X-Chatticus-Invoke-Key";

type GatewayStreams = ReturnType<typeof openAIResponsesApi>;
type GatewaySender = typeof globalThis.fetch;

const timedSender = (log: LogEmitter, model: string, base: GatewaySender | undefined): GatewaySender => {
	return async (input, init) => {
		const startedAt = Date.now();
		try {
			const response = await (base ?? globalThis.fetch)(input, init);
			log("model_call", { model, status: response.status, duration_ms: Date.now() - startedAt });
			return response;
		} catch (error) {
			log("model_call", { model, status: null, error_name: errorNameOf(error), duration_ms: Date.now() - startedAt });
			throw error;
		}
	};
};

const loggedStreams = (streams: GatewayStreams, log: LogEmitter): GatewayStreams => ({
	...streams,
	stream: (model, context, options) => streams.stream(model, context, { ...options, fetch: timedSender(log, model.id, options?.fetch) }),
	streamSimple: (model, context, options) => streams.streamSimple(model, context, { ...options, fetch: timedSender(log, model.id, options?.fetch) }),
});

/**
 * The model collection of a container owner: the OpenAI chat models the Lambda owner uses, with every request pointed at
 * the gateway and authenticated by the injected token.
 *
 * @param gateway The gateway address and token.
 * @param log Receives one `model_call` line for each HTTP request to the gateway, with the status the gateway answered and
 * the milliseconds until its response headers arrived; a request that never got a response writes `status=none` and the
 * error's name. It never receives a header value or a body. Absent, nothing is written.
 * @returns A collection whose only provider reaches the gateway.
 */
export function createGatewayModels(gateway: ModelGatewayConfig, log?: LogEmitter): Models {
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
			models: vendor.getModels().map((model) => ({
				...model,
				baseUrl: gateway.baseUrl,
				...(gateway.invokeKey === undefined || gateway.invokeKey === ""
					? {}
					: { headers: { ...model.headers, [INVOKE_KEY_HEADER]: gateway.invokeKey } }),
			})),
			api: log === undefined ? openAIResponsesApi() : loggedStreams(openAIResponsesApi(), log),
		}),
	);
	return models;
}
