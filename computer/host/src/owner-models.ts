import { errorNameOf, type LogEmitter } from "../../../conversation/src/observability/log-line.ts";
import { createModels, createProvider, type Models } from "@earendil-works/pi-ai/models";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

/**
 * Where the container owner sends model requests: the control plane's model gateway, never the vendor. The container holds
 * no token of its own: the gateway's per-turn token is read from the supervisor each time a request is sent, so a token the
 * supervisor renewed is the one the next request carries. The gateway itself is not part of this program; a deployment
 * injects its address.
 */
export type ModelGatewayConfig = {
	/** The gateway's address in place of the vendor's API address, for example `https://gateway.example/v1`. */
	readonly baseUrl: string;
	/** Resolves the token sent in place of the vendor key, which the gateway bound to one tenant, bot and turn. It rejects when the supervisor holds none, and the request then fails. */
	readonly tokenProvider: () => Promise<string>;
};

type GatewayStreams = ReturnType<typeof openAIResponsesApi>;
type GatewaySender = typeof globalThis.fetch;

const PLACEHOLDER_API_KEY = "replaced-for-each-request-by-the-model-gateway-sender";

const authenticatedSender = (tokenProvider: () => Promise<string>, base: GatewaySender): GatewaySender => {
	return async (input, init) => {
		const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
		headers.set("authorization", `Bearer ${await tokenProvider()}`);
		return base(input, { ...init, headers });
	};
};

const timedSender = (log: LogEmitter, model: string, base: GatewaySender): GatewaySender => {
	return async (input, init) => {
		const startedAt = Date.now();
		try {
			const response = await base(input, init);
			log("model_call", { model, status: response.status, duration_ms: Date.now() - startedAt });
			return response;
		} catch (error) {
			log("model_call", { model, status: null, error_name: errorNameOf(error), duration_ms: Date.now() - startedAt });
			throw error;
		}
	};
};

const gatewaySender = (gateway: ModelGatewayConfig, log: LogEmitter | undefined, model: string, base: GatewaySender | undefined): GatewaySender => {
	const sender = base ?? globalThis.fetch;
	return authenticatedSender(gateway.tokenProvider, log === undefined ? sender : timedSender(log, model, sender));
};

const gatewayStreams = (streams: GatewayStreams, gateway: ModelGatewayConfig, log: LogEmitter | undefined): GatewayStreams => ({
	...streams,
	stream: (model, context, options) => streams.stream(model, context, { ...options, fetch: gatewaySender(gateway, log, model.id, options?.fetch) }),
	streamSimple: (model, context, options) => streams.streamSimple(model, context, { ...options, fetch: gatewaySender(gateway, log, model.id, options?.fetch) }),
});

/**
 * The model collection of a container owner: the OpenAI chat models the Lambda owner uses, with every request pointed at
 * the gateway and authenticated by the token the supervisor holds when the request is sent: the Front Door accepts the
 * gateway's session token without the deployment's invoke key, so the container never holds that key. The token is applied
 * to each HTTP request by a wrapper around the request function, not by Pi's key resolution, which returns a placeholder.
 *
 * @param gateway The gateway address and the provider of its token.
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
						return { auth: { apiKey: PLACEHOLDER_API_KEY }, source: "model gateway token" };
					},
				},
			},
			models: vendor.getModels().map((model) => ({
				...model,
				baseUrl: gateway.baseUrl,
			})),
			api: gatewayStreams(openAIResponsesApi(), gateway, log),
		}),
	);
	return models;
}
