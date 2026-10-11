import type { ToolEventArguments } from "../domain/turns.ts";

/** The most characters of a command the `tool.call` arguments keep. */
export const COMMAND_ARGUMENT_LIMIT = 1000;

/** The most characters of a file content preview the `tool.call` arguments keep. */
export const WRITE_PREVIEW_LIMIT = 200;

/** The most characters of each side of an edit the `tool.call` arguments keep. */
export const EDIT_TEXT_LIMIT = 300;

/** The most characters of a path or a URL the `tool.call` arguments keep. */
export const LOCATION_ARGUMENT_LIMIT = 500;

/** The most characters of any other string argument the `tool.call` arguments keep. */
export const GENERIC_ARGUMENT_LIMIT = 300;

/** The most arguments of a tool without its own shape that the `tool.call` event keeps. */
export const GENERIC_ARGUMENT_COUNT_LIMIT = 10;

/** The most characters of an argument name the `tool.call` event keeps. */
export const ARGUMENT_NAME_LIMIT = 64;

/** The longest output a `tool.result` carries whole; a longer one keeps its head and tail. */
export const OUTPUT_LIMIT = 3000;

/** The characters kept at each end of an output that was cut. */
export const OUTPUT_KEPT_EACH_END = 1500;

/** The characters of a command or an error message a summary line quotes. */
export const SUMMARY_QUOTE_LIMIT = 80;

/** The shortest environment value that is treated as a secret to redact; shorter ones would redact ordinary words. */
export const MINIMUM_SECRET_LENGTH = 8;

const NAMED_SECRET_VARIABLES: readonly string[] = [
	"CHATTICUS_MODEL_GATEWAY_TOKEN",
	"CHATTICUS_OWNER_HOST_TOKEN",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
];

const SECRET_NAME_PATTERN = /KEY|TOKEN|SECRET/i;

const REDACTED = "[redacted]";

/**
 * The environment values that must never appear in an event: the named gateway, owner and AWS secrets, and the value of
 * every variable whose name contains KEY, TOKEN or SECRET.
 *
 * @param environment The process environment.
 * @returns The distinct secret values, longest first so a value that contains another is replaced whole.
 */
export function secretValuesOf(environment: NodeJS.ProcessEnv): string[] {
	const values = new Set<string>();
	for (const [name, value] of Object.entries(environment)) {
		if (value === undefined || value.length < MINIMUM_SECRET_LENGTH) continue;
		if (NAMED_SECRET_VARIABLES.includes(name) || SECRET_NAME_PATTERN.test(name)) values.add(value);
	}
	return [...values].sort((left, right) => right.length - left.length);
}

/**
 * Replace every secret value of the process environment found in a text with `[redacted]`.
 *
 * @param text Any text bound for an event.
 * @param environment The environment whose secrets are removed; the process's own by default.
 * @returns The text without the secrets.
 */
export function redactSecrets(text: string, environment: NodeJS.ProcessEnv = process.env): string {
	let result = text;
	for (const secret of secretValuesOf(environment)) result = result.split(secret).join(REDACTED);
	return result;
}

const cut = (text: string, limit: number): { text: string; cut: boolean } =>
	text.length > limit ? { text: text.slice(0, limit), cut: true } : { text, cut: false };

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** What a `tool.call` event carries besides its identity. */
export type ToolCallFields = {
	readonly tool: string;
	readonly callId: string;
	readonly summary: string;
	readonly toolArguments: ToolEventArguments;
	readonly argumentsTruncated: boolean;
	/** The bytes of content a `write_workspace` call writes; null for every other tool. */
	readonly writtenBytes: number | null;
};

const stringOf = (value: unknown): string => (typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value));

/**
 * The sanitized arguments and the summary line of one tool call. Secrets of the process environment are replaced before
 * anything is cut, so a cut can never leave half a secret.
 *
 * @param tool The tool name.
 * @param callId The Pi tool call id.
 * @param rawArguments The arguments the model gave.
 * @param environment The environment whose secrets are removed.
 * @returns The event fields.
 */
export function toolCallFields(
	tool: string,
	callId: string,
	rawArguments: Readonly<Record<string, unknown>>,
	environment: NodeJS.ProcessEnv = process.env,
): ToolCallFields {
	const text = (name: string): string => redactSecrets(stringOf(rawArguments[name]), environment);
	let truncated = false;
	const take = (value: string, limit: number): string => {
		const piece = cut(value, limit);
		truncated ||= piece.cut;
		return piece.text;
	};
	const finish = (summary: string, toolArguments: ToolEventArguments, writtenBytes: number | null = null): ToolCallFields => ({
		tool,
		callId,
		summary,
		toolArguments,
		argumentsTruncated: truncated,
		writtenBytes,
	});
	switch (tool) {
		case "run_terminal": {
			const command = take(text("command"), COMMAND_ARGUMENT_LIMIT);
			return finish(`Running: ${oneLine(command).slice(0, SUMMARY_QUOTE_LIMIT)}`, { command });
		}
		case "read_workspace": {
			const path = take(text("path"), LOCATION_ARGUMENT_LIMIT);
			return finish(`Reading ${path}`, { path });
		}
		case "write_workspace": {
			const path = take(text("path"), LOCATION_ARGUMENT_LIMIT);
			const content = stringOf(rawArguments["content"]);
			const bytes = Buffer.byteLength(content);
			const preview = take(redactSecrets(content, environment), WRITE_PREVIEW_LIMIT);
			return finish(`Writing ${path} (${bytes} bytes)`, { path, bytes, preview }, bytes);
		}
		case "edit_workspace": {
			const path = take(text("path"), LOCATION_ARGUMENT_LIMIT);
			const oldText = take(text("old_text"), EDIT_TEXT_LIMIT);
			const newText = take(text("new_text"), EDIT_TEXT_LIMIT);
			return finish(`Editing ${path}`, { path, old_text: oldText, new_text: newText });
		}
		case "browse": {
			const url = take(text("url"), LOCATION_ARGUMENT_LIMIT);
			return finish(`Browsing ${url}`, { url });
		}
		default: {
			const toolArguments: ToolEventArguments = {};
			let kept = 0;
			for (const [name, value] of Object.entries(rawArguments)) {
				const primitive = typeof value === "string" || typeof value === "number" || typeof value === "boolean";
				if (!primitive || kept >= GENERIC_ARGUMENT_COUNT_LIMIT) {
					truncated = true;
					continue;
				}
				kept += 1;
				const key = take(name, ARGUMENT_NAME_LIMIT);
				toolArguments[key] = typeof value === "string" ? take(redactSecrets(value, environment), GENERIC_ARGUMENT_LIMIT) : value;
			}
			return finish(`Calling ${tool}`, toolArguments);
		}
	}
}

/** What a `tool.result` event carries besides its identity. */
export type ToolResultFields = {
	readonly tool: string;
	readonly callId: string;
	readonly ok: boolean;
	readonly summary: string;
	readonly output: string;
	readonly outputTruncated: boolean;
	readonly durationMs: number | null;
};

const EXIT_PREFIX = /^run_terminal:exit=(-?\d+)/;
const EXIT_ERROR = /Command exited with code (-?\d+)/;
const REPLACED_BLOCKS = /replaced (\d+) block/i;

/**
 * Keep an output whole up to the limit; keep its head and its tail with a marker between when it is longer.
 *
 * @param text The output.
 * @returns The output as the event carries it, and whether it was cut.
 */
export function boundedEventOutput(text: string): { output: string; truncated: boolean } {
	if (text.length <= OUTPUT_LIMIT) return { output: text, truncated: false };
	const omitted = text.length - 2 * OUTPUT_KEPT_EACH_END;
	return {
		output: `${text.slice(0, OUTPUT_KEPT_EACH_END)}\n...[${omitted} characters omitted]...\n${text.slice(text.length - OUTPUT_KEPT_EACH_END)}`,
		truncated: true,
	};
}

/**
 * The outcome, the summary line and the bounded output of one finished tool call. Secrets of the process environment
 * are replaced in the text before it is bounded.
 *
 * @param tool The tool name.
 * @param callId The Pi tool call id.
 * @param resultText The text the tool answered with.
 * @param isError Whether the harness recorded the result as an error.
 * @param writtenBytes The bytes a `write_workspace` call wrote, when the call was seen.
 * @param durationMs How long the call took as far as this attempt saw it, or null.
 * @param environment The environment whose secrets are removed.
 * @returns The event fields.
 */
export function toolResultFields(
	tool: string,
	callId: string,
	resultText: string,
	isError: boolean,
	writtenBytes: number | null,
	durationMs: number | null,
	environment: NodeJS.ProcessEnv = process.env,
): ToolResultFields {
	const text = redactSecrets(resultText, environment);
	const bounded = boundedEventOutput(text);
	const base = { tool, callId, output: bounded.output, outputTruncated: bounded.truncated, durationMs };
	const failure = (): ToolResultFields => ({
		...base,
		ok: false,
		summary: `Error: ${oneLine(text).slice(0, SUMMARY_QUOTE_LIMIT)}`,
	});
	if (tool === "run_terminal") {
		const code = EXIT_PREFIX.exec(text) ?? (isError ? EXIT_ERROR.exec(text) : null);
		if (code !== null) return { ...base, ok: Number(code[1]) === 0, summary: `Exit ${code[1]}` };
		return isError ? failure() : { ...base, ok: true, summary: "Exit 0" };
	}
	if (isError) return failure();
	if (tool === "edit_workspace") {
		const blocks = REPLACED_BLOCKS.exec(text)?.[1] ?? "1";
		return { ...base, ok: true, summary: `Edited ${blocks} ${blocks === "1" ? "block" : "blocks"}` };
	}
	if (tool === "write_workspace") {
		return { ...base, ok: true, summary: writtenBytes === null ? "Wrote file" : `Wrote ${writtenBytes} bytes` };
	}
	return { ...base, ok: true, summary: "Done" };
}
