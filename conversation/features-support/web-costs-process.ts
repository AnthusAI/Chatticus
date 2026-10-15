import { startLongLivedWebHarness } from "./web-harness-runner.ts";

export type CostsTestElement = { testId: string; text: string; label: string | null };

export type CostsRequest = {
	method: string;
	route: string;
	query: Record<string, string>;
	headers: Record<string, string>;
};

export type CostsState = {
	html: string;
	text: string;
	elements: CostsTestElement[];
	requests: CostsRequest[];
	exportRequest: { format: string | null; grain: string | null };
	delivered: Array<{ filename: string; mimeType: string; text: string }>;
	organizationStatus: string;
	channelStatus: string;
};

/**
* The real Costs controller and views and a fake cost API, in one long-lived
* tsx process. Steps send it JSON commands; the code under test is the
* production web code.
*/
export class CostsProcess {
	private readonly harness = startLongLivedWebHarness("costs-harness.ts");

	send<T = unknown>(command: Record<string, unknown>): Promise<T> {
		return this.harness.send<T>(command);
	}

	state(): Promise<CostsState> {
		return this.send<CostsState>({ op: "state" });
	}

	call(method: string, ...args: unknown[]): Promise<unknown> {
		return this.send({ op: "call", method, args });
	}

	fake(method: string, ...args: unknown[]): Promise<unknown> {
		return this.send({ op: "fake", method, args });
	}

	close(): void {
		this.harness.close();
	}
}
