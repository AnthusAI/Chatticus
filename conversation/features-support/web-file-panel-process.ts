import { startLongLivedWebHarness } from "./web-harness-runner.ts";

export type PanelSnapshotFacts = {
	sourceText: string;
	directory: string;
	openFile: string | null;
	marks: Record<string, string>;
	edit: { draft: string; path: string; phase: string; piChanged: boolean; notice: { kind: string } | null } | null;
	conflict: { origin: string; theirsText: string; mineText: string; path: string } | null;
	confirm: { id: string; text: string; confirmLabel: string | null; cancelLabel: string } | null;
	status: { tone: string; text: string; detail: string | null } | null;
	pendingDescriptions: string[];
	pendingPaths: string[];
	pendingOpen: boolean;
	listingNames: string[];
	changesOffered: boolean;
};

export type PanelState = {
	snapshot: PanelSnapshotFacts;
	html: string;
	text: string;
	timersDueIn: number[];
	nowMs: number;
};

export type FakeComputerState = {
	mode: string;
	otherRequests: string[];
	requests: Array<{ method: string; route: string; query: Record<string, string>; headers: Record<string, string>; body: unknown; keepalive: boolean }>;
	audit: Array<{ operation: string; path: string; user: string; source: string }>;
	live: Record<string, string>;
	listingNames: string[];
	exists: boolean | null;
	overlayCount: number;
};

/**
* The real Files panel controller, a fake clock and a fake running computer,
* in one long-lived tsx process. Steps send it JSON commands; the panel code
* under test is the production code.
*/
export class FilePanelProcess {
	private readonly harness = startLongLivedWebHarness("computer-files-harness.ts");

	send<T = unknown>(command: Record<string, unknown>): Promise<T> {
		return this.harness.send<T>(command);
	}

	state(): Promise<PanelState> {
		return this.send<PanelState>({ op: "state" });
	}

	fakeState(directory?: string, path?: string): Promise<FakeComputerState> {
		return this.send<FakeComputerState>({ op: "fake-state", directory, path });
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
