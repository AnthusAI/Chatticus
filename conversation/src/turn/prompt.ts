/** What the system prompt says about the bot. */
export type PromptSubject = { readonly botName: string; readonly memory: Readonly<Record<string, string>> };

/** What every bot is told about its computer. */
export const COMPUTER_GUIDANCE_LINES: readonly string[] = [
	"The organization has a computer. Its /workspace folder is a persistent workspace that all teammates share. Files there stay between turns.",
	"Git is installed. Use run_terminal to run shell commands in /workspace.",
	"To change an existing file, use edit_workspace. To create a new file, use write_workspace.",
];

/**
 * The bot's system prompt: who it is, what it may do on the computer and what it remembers. It is rendered into every
 * model call as a Pi section and is never stored in the transcript, so a change to the bot's memory shows in the next
 * turn.
 *
 * @param subject The bot's name and memory.
 * @returns The fixed line, the computer guidance, then one `memory <key>: <value>` line per remembered key in key order.
 */
export function buildSystemPrompt(subject: PromptSubject): string {
	const memoryLines = Object.keys(subject.memory)
		.sort()
		.map((key) => `memory ${key}: ${subject.memory[key]}`);
	return [`You are ${subject.botName}, a teammate in a Chatticus conversation. Answer briefly.`, ...COMPUTER_GUIDANCE_LINES, ...memoryLines].join("\n");
}
