/** What the system prompt says about the bot. */
export type PromptSubject = { readonly botName: string; readonly memory: Readonly<Record<string, string>> };

/**
 * The bot's system prompt: who it is and what it remembers. It is rendered into every model call as a Pi section and
 * is never stored in the transcript, so a change to the bot's memory shows in the next turn.
 *
 * @param subject The bot's name and memory.
 * @returns The fixed line, then one `memory <key>: <value>` line per remembered key in key order.
 */
export function buildSystemPrompt(subject: PromptSubject): string {
	const memoryLines = Object.keys(subject.memory)
		.sort()
		.map((key) => `memory ${key}: ${subject.memory[key]}`);
	return [`You are ${subject.botName}, a teammate in a Chatticus conversation. Answer briefly.`, ...memoryLines].join("\n");
}
