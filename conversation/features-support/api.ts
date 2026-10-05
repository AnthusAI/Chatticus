/**
 * HTTP API client for testing. Takes any object with a `request` method and
 * provides get, post, put, patch, delete methods that return Promises.
 */
export class ApiClient {
	private app: { request: (input: Request | string, init?: RequestInit) => Response | Promise<Response> };

	constructor(app: { request: (input: Request | string, init?: RequestInit) => Response | Promise<Response> }) {
		this.app = app;
	}

	async get(path: string, options?: { headers?: Record<string, string> }): Promise<Response> {
		return this.request("GET", path, options);
	}

	async post(path: string, options?: { headers?: Record<string, string>; body?: unknown }): Promise<Response> {
		return this.request("POST", path, options);
	}

	async put(path: string, options?: { headers?: Record<string, string>; body?: unknown }): Promise<Response> {
		return this.request("PUT", path, options);
	}

	async patch(path: string, options?: { headers?: Record<string, string>; body?: unknown }): Promise<Response> {
		return this.request("PATCH", path, options);
	}

	async delete(path: string, options?: { headers?: Record<string, string>; body?: unknown }): Promise<Response> {
		return this.request("DELETE", path, options);
	}

	private async request(
		method: string,
		path: string,
		options?: { headers?: Record<string, string>; body?: unknown },
	): Promise<Response> {
		const headers = options?.headers ? { ...options.headers } : {};

		if (options?.body !== undefined) {
			if (!headers["content-type"]) {
				headers["content-type"] = "application/json";
			}
		}

		const init: RequestInit = {
			method,
			headers,
		};

		if (options?.body !== undefined) {
			init.body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
		}

		const response = await this.app.request(path, init);
		return response;
	}
}
