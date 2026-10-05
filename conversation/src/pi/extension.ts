import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, section } from "@earendil-works/pi-durable";

export type ChatticusExtensionOptions = {
	readonly systemPrompt: () => string;
	readonly onChannelNote?: (note: string) => void;
};

/**
 * The Chatticus extension bundle: one untagged system prompt section and the `note_to_channel` tool.
 *
 * @param options Prompt renderer and an optional sink for the tool.
 * @returns The extensions to install into a registry.
 */
export function chatticusExtensions(options: ChatticusExtensionOptions): Extension[] {
	const noteTool = defineTool({
		name: "note_to_channel",
		description: "Record a short note for the channel and return an acknowledgement.",
		parameters: Type.Object({ note: Type.String() }),
		replay: "safe",
		execute: async (args) => {
			options.onChannelNote?.(args.note);
			return { content: [{ type: "text", text: `noted: ${args.note}` }] };
		},
	});
	return [
		defineExtension({
			name: "chatticus",
			sections: [section("chatticus-system", options.systemPrompt, { tag: false })],
			tools: [noteTool],
		}),
	];
}
