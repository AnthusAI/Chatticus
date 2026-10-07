/**
 * Q4 evidence: does pi-durable's bash tool hand the owner's environment to a model-chosen command?
 * Runs the built-in bash tool through NodeExecutionEnv with a fake secret in the owner's environment.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools, createBashTool } from "@earendil-works/pi-durable/tools";
import type { ToolRegistration } from "@earendil-works/pi-durable";

process.env.OPENAI_API_KEY = "sk-fake-owner-secret";
process.env.AWS_SECRET_ACCESS_KEY = "fake-aws-secret";
const env = new NodeExecutionEnv({ cwd: "/tmp" });

async function run(label: string, tool: ToolRegistration): Promise<void> {
	let captured = "";
	const api = {
		env,
		callId: "c",
		output: (chunk: string | Uint8Array) => {
			captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		},
		diagnostic: () => undefined,
		details: async () => undefined,
	};
	await (tool.execute as (...rest: unknown[]) => Promise<unknown>)({ command: 'echo "key=$OPENAI_API_KEY aws=$AWS_SECRET_ACCESS_KEY"' }, api, BACKGROUND_CONTEXT);
	console.log(`${label}: ${captured.trim()}`);
}

const shipped = (CodingTools.tools as readonly ToolRegistration[]).find((tool) => tool.name === "bash")!;
await run("bash as shipped            ", shipped);
const scrubbed = createBashTool({
	prepare: (execution) => {
		execution.inheritEnv = false;
		execution.env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/workspace" };
	},
});
await run("bash with prepare() scrubbing", scrubbed);
