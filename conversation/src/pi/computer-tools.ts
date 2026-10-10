/**
 * The computer tools: `read_workspace`, `write_workspace`, `edit_workspace`, `run_terminal`, `browse` and `request_computer_capability`,
 * plus `send` and `purchase`, which can only run after a human approved their exact arguments.
 *
 * Every computer tool is registered on every owner with the same schema and is declared `replay: "safe"`, because its
 * `execute` is a lookup-or-park and so idempotent by construction (the design, the parked-tool handoff):
 *
 * - the action recorded for this Pi call id is done: return its result, the effect already happened on the host;
 * - there is none and new computer work is refused (the spend ceiling): return the refusal as the result;
 * - otherwise hand the call to the executor, which records the action and parks the turn, and wait to be closed.
 *
 * Every computer tool is `executionMode: "sequential"`, which makes the whole round of one assistant message sequential.
 * The turn parks on one pending action at a time, so each of N parallel calls records its action, parks and resumes in
 * call order, and no call finishes in the instant the owner closes: a stopped event stream drops the batches it has not
 * delivered, which in a parallel round lost the `tool.result` events of the calls that had just completed.
 *
 * `Harness.close` stops the invocation without writing an outcome, so the `pi.tool` task stays at its `execute`
 * checkpoint and the next owner, with a higher fence, runs `execute` again and finds the result by call id. Verified in
 * `test/computer-park-resume.test.ts` and `docs/PI_HARNESS.md`.
 */

import { BROWSE_ACTION_KIND, REQUEST_COMPUTER_CAPABILITY_ACTION_KIND } from "@chatticus/host-protocol";
import { type Static, Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ComputerAction } from "../domain/actions.ts";

/** The tool arguments as the strings the policy and the host read. */
export const stringArguments = (value: unknown): Record<string, string> => {
	const result: Record<string, string> = {};
	if (typeof value === "object" && value !== null) {
		for (const [name, entry] of Object.entries(value)) result[name] = typeof entry === "string" ? entry : JSON.stringify(entry);
	}
	return result;
};

/** What a computer tool call is handed when the gate allows it. */
export type ComputerToolCall = {
	readonly toolName: string;
	readonly arguments: Readonly<Record<string, string>>;
	readonly callId: string;
};

/** What a computer tool needs from the owner that runs it. */
export interface ComputerToolHandoff {
	/** The action recorded for the call, in whatever state, or null when the call has none. */
	lookup(call: ComputerToolCall): Promise<ComputerAction | null>;
	/** Why new computer work must not start, or null when it may. */
	refusal(call: ComputerToolCall): Promise<string | null>;
	/** The text the call answers with when the computer's image cannot run this tool at all, or null when it can. */
	unavailable(call: ComputerToolCall): Promise<string | null>;
	/**
	 * Give the call to the executor, which records its action and parks the turn. The returned promise never settles
	 * with a value: it rejects when the owner is closed, which the harness does not turn into a tool result.
	 */
	park(call: ComputerToolCall, abortSignal: AbortSignal | undefined): Promise<never>;
}

/** The text a refused call answers with. */
export const computerWorkPausedText = (reason: string): string => `Computer work is paused: ${reason}.`;

const READ_WORKSPACE_PARAMETERS = Type.Object({ path: Type.String({ description: "Absolute path of the file under /workspace." }) });
const WRITE_WORKSPACE_PARAMETERS = Type.Object({
	path: Type.String({ description: "Absolute path of the file under /workspace." }),
	content: Type.String({ description: "The full text to write." }),
});
const EDIT_WORKSPACE_PARAMETERS = Type.Object({
	path: Type.String({ description: "Absolute path of the existing file under /workspace." }),
	old_text: Type.String({ description: "The exact text to replace. It must occur once in the file." }),
	new_text: Type.String({ description: "The text to put in its place." }),
});
const RUN_TERMINAL_PARAMETERS = Type.Object({
	command: Type.String({ description: "The shell command to run." }),
	cwd: Type.Optional(Type.String({ description: "Working directory; defaults to /workspace." })),
});
const BROWSE_PARAMETERS = Type.Object({ url: Type.String({ description: "The page to open." }) });
const REQUEST_COMPUTER_CAPABILITY_PARAMETERS = Type.Object({
	capability: Type.String({ description: "What the computer should be able to do, such as a browser session." }),
	url: Type.Optional(Type.String({ description: "The page the capability is needed for, when there is one." })),
});
const SEND_PARAMETERS = Type.Object({
	recipient: Type.String({ description: "Who receives the message." }),
	body: Type.Optional(Type.String({ description: "The message text." })),
});

const PURCHASE_PARAMETERS = Type.Object({
	item: Type.String({ description: "What to buy." }),
	origin: Type.Optional(Type.String({ description: "The store the item is bought from." })),
});

/**
 * The tools the model has beyond the channel note, with their schemas. The gate decides every call before it reaches
 * `execute`; an allowed computer call is a lookup-or-park through `handoff`.
 *
 * @param handoff The owner's side of the handoff.
 * @returns The extension holding the tools.
 */
export function computerToolsExtension(handoff: ComputerToolHandoff): Extension {
	const computerTool = <P extends ReturnType<typeof Type.Object>>(
		name: string,
		description: string,
		parameters: P,
	): ToolRegistration =>
		defineTool({
			name,
			description,
			parameters,
			replay: "safe",
			executionMode: "sequential",
			execute: async (args: Static<P>, api, toolContext) => {
				const call: ComputerToolCall = { toolName: name, arguments: stringArguments(args), callId: api.callId };
				const action = await handoff.lookup(call);
				if (action?.status === "done") {
					const text = action.result ?? "";
					if (action.resultIsError) throw new Error(text);
					return { content: [{ type: "text", text }] };
				}
				if (action === null) {
					const unavailableText = await handoff.unavailable(call);
					if (unavailableText !== null) return { content: [{ type: "text", text: unavailableText }] };
					const reason = await handoff.refusal(call);
					if (reason !== null) return { content: [{ type: "text", text: computerWorkPausedText(reason) }] };
				}
				return handoff.park(call, toolContext.abortSignal);
			},
		}) as unknown as ToolRegistration;
	const sendTool = defineTool({
		name: "send",
		description: "Send a message to a person outside the channel. A human approves the exact message first.",
		parameters: SEND_PARAMETERS,
		replay: "unsafe",
		execute: async () => {
			throw new Error("send runs only after a human approved its exact arguments.");
		},
	}) as unknown as ToolRegistration;
	const purchaseTool = defineTool({
		name: "purchase",
		description: "Buy an item for the organization. A human approves the exact purchase first.",
		parameters: PURCHASE_PARAMETERS,
		replay: "unsafe",
		execute: async () => {
			throw new Error("purchase runs only after a human approved its exact arguments.");
		},
	}) as unknown as ToolRegistration;
	return defineExtension({
		name: "computer",
		tools: [
			computerTool("read_workspace", "Read a file in /workspace, the persistent workspace of the organization.", READ_WORKSPACE_PARAMETERS),
			computerTool(
				"write_workspace",
				"Write a new file in /workspace. This replaces the whole file. To change part of an existing file, use edit_workspace.",
				WRITE_WORKSPACE_PARAMETERS,
			),
			computerTool(
				"edit_workspace",
				"Change an existing file in /workspace. It replaces one exact piece of text. It fails if the text is not found or occurs more than once. It never creates a file.",
				EDIT_WORKSPACE_PARAMETERS,
			),
			computerTool(
				"run_terminal",
				"Run a shell command on the organization's computer. The default directory is /workspace. Git, gcc, g++ and make are installed.",
				RUN_TERMINAL_PARAMETERS,
			),
			computerTool(BROWSE_ACTION_KIND, "Open a web page in an isolated browser.", BROWSE_PARAMETERS),
			computerTool(
				REQUEST_COMPUTER_CAPABILITY_ACTION_KIND,
				"Ask for a capability of the organization's computer, such as a browser session.",
				REQUEST_COMPUTER_CAPABILITY_PARAMETERS,
			),
			sendTool,
			purchaseTool,
		],
	});
}
