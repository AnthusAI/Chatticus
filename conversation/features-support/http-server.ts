import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Hono } from "hono";

/** A Hono application served on a loopback port for steps that need a real HTTP base URL. */
export type StartedAppServer = {
	baseUrl: string;
	close(): Promise<void>;
};

async function readBody(request: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

/** Serve `app` on 127.0.0.1 on an ephemeral port. */
export async function startAppServer(app: Hono): Promise<StartedAppServer> {
	const server: Server = createServer(async (incoming, outgoing) => {
		const headers = new Headers();
		for (const [name, value] of Object.entries(incoming.headers)) {
			if (value !== undefined) {
				headers.set(name, Array.isArray(value) ? value.join(", ") : value);
			}
		}
		const method = incoming.method ?? "GET";
		const body = method === "GET" || method === "HEAD" ? undefined : new Uint8Array(await readBody(incoming));
		const request = new Request(`http://${incoming.headers.host}${incoming.url}`, { method, headers, body });
		const response = await app.fetch(request);
		outgoing.statusCode = response.status;
		response.headers.forEach((value, name) => outgoing.setHeader(name, value));
		outgoing.end(Buffer.from(await response.arrayBuffer()));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.closeAllConnections();
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}
