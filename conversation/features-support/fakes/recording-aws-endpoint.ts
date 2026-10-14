import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** Which service a request to the endpoint was for, told from its shape. `decoy` is a path nothing in the child may ask for. */
export type RecordedEndpointService = "dynamodb" | "s3" | "model_gateway" | "decoy";

/** One request the endpoint received: when it arrived in the scenario's time, what it was for, and which credentials signed it. */
export type RecordedEndpointRequest = {
	readonly atMilliseconds: number;
	readonly service: RecordedEndpointService;
	readonly path: string;
	/** The access key id of the AWS signature, or null when the request was not signed. */
	readonly accessKeyId: string | null;
	/** The bearer token of the Authorization header, or null when it carried none. */
	readonly bearerToken: string | null;
};

const SERVICE_BY_PREFIX: ReadonlyArray<readonly [string, RecordedEndpointService]> = [
	["/decoy", "decoy"],
	["/v1/", "model_gateway"],
];

/**
 * A local HTTP endpoint that stands in for DynamoDB, S3 and the model gateway at once, and records each request with the
 * credentials that signed it. It answers every request at once and means nothing by its answers: a scenario reads what it
 * recorded. The AWS SDK reaches it through the `AWS_ENDPOINT_URL` variable, so the clients under test are the real clients.
 */
export class RecordingAwsEndpoint {
	readonly requests: RecordedEndpointRequest[] = [];
	private readonly nowMilliseconds: () => number;
	private server: Server | null = null;
	private listeningPort = 0;

	constructor(nowMilliseconds: () => number) {
		this.nowMilliseconds = nowMilliseconds;
	}

	/** The address a client is pointed at. */
	get baseUrl(): string {
		return `http://127.0.0.1:${this.listeningPort}`;
	}

	/** Begin listening on a free loopback port. */
	async start(): Promise<void> {
		const server = createServer((request, response) => this.answer(request, response));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		this.listeningPort = (server.address() as AddressInfo).port;
		this.server = server;
	}

	/** Stop listening and drop every open connection. */
	async stop(): Promise<void> {
		const server = this.server;
		this.server = null;
		if (server === null) return;
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections();
		});
	}

	/** The recorded requests for one service. */
	requestsFor(service: RecordedEndpointService): RecordedEndpointRequest[] {
		return this.requests.filter((request) => request.service === service);
	}

	private answer(request: IncomingMessage, response: ServerResponse): void {
		request.resume();
		request.on("end", () => {
			const path = request.url ?? "";
			const authorization = String(request.headers["authorization"] ?? "");
			const signature = /Credential=([^/]+)\//.exec(authorization);
			const bearer = /^Bearer (.+)$/.exec(authorization);
			const service: RecordedEndpointService =
				SERVICE_BY_PREFIX.find(([prefix]) => path.startsWith(prefix))?.[1] ?? (request.headers["x-amz-target"] === undefined ? "s3" : "dynamodb");
			this.requests.push({ atMilliseconds: this.nowMilliseconds(), service, path, accessKeyId: signature?.[1] ?? null, bearerToken: bearer?.[1] ?? null });
			if (service === "dynamodb") {
				response.writeHead(200, { "content-type": "application/x-amz-json-1.0" });
				response.end("{}");
			} else if (service === "model_gateway") {
				response.writeHead(401, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { message: "the scenario endpoint records requests and answers none", type: "invalid_request_error" } }));
			} else {
				response.writeHead(service === "decoy" ? 404 : 200);
				response.end();
			}
		});
	}
}
