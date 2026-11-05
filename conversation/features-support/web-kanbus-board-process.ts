import { startLongLivedWebHarness } from "./web-harness-runner.ts";

export type KanbusBoardTestElement = { testId: string; text: string };

export type KanbusBoardCard = {
	id: string;
	type: string;
	priority: string;
	text: string;
};

export type KanbusBoardColumn = {
	key: string;
	headerText: string;
	cards: KanbusBoardCard[];
};

export type KanbusBoardRequest = {
	method: string;
	route: string;
	query: Record<string, string>;
};

export type KanbusBoardDrawing = {
	kind: string;
	wrapperClass: string;
	columnClass: string;
	cardClass: string;
};

export type KanbusBoardState = {
	html: string;
	text: string;
	elements: KanbusBoardTestElement[];
	columns: KanbusBoardColumn[];
	requests: KanbusBoardRequest[];
	botBoardRequests: Array<{ method: string; path: string; query: Record<string, string> }>;
	computerRequestsSincePick: string[];
	drawings: KanbusBoardDrawing[];
};

/**
* The real Board panel controller, its frame and the `@kanbus/ui` board component and a fake running computer behind the member file routes, in one
* long-lived tsx process. Steps send it JSON commands; the code under test is the production web code.
*/
export class KanbusBoardProcess {
	private readonly harness = startLongLivedWebHarness("kanbus-board-harness.ts", { TSX_TSCONFIG_PATH: "tsconfig.harness.json" });

	send<T = unknown>(command: Record<string, unknown>): Promise<T> {
		return this.harness.send<T>(command);
	}

	state(): Promise<KanbusBoardState> {
		return this.send<KanbusBoardState>({ op: "state" });
	}

	close(): void {
		this.harness.close();
	}
}
