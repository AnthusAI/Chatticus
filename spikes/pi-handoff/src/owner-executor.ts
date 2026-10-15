/**
 * One owner process of the executor scenario. The production turn executor (`consumeRunJob`) runs the turn.
 *
 * Roles (first argument):
 * - `a`  Lambda-like. The production executor, unchanged (conversation/src/turn/executor.ts), park tools. It parks the turn.
 * - `b`  container-like. The executor with the one-line seam (generated/executor-seamed.ts) and local tools. It resumes the
 *        waiting turn, then runs it. Its deps carry no remaining-time probe.
 * - `a2` Lambda-like again, for the next turn of the same conversation. Unchanged executor.
 *
 * Environment: SPIKE_JOB (JSON of the run job), SPIKE_JOURNAL, SPIKE_WORKSPACE.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getTurn } from "../../../conversation/src/domain/turns.ts";
import { resumeTurnForAction } from "../../../conversation/src/turn/park.ts";
import { consumeRunJob } from "../../../conversation/src/turn/executor.ts";
import { ScriptedProvider } from "../../../conversation/features-support/fakes/scripted-provider.ts";
import { awsSurface, journal } from "./common.ts";
import { buildExecutorDeps, scriptedModels } from "./executor-world.ts";
import { localComputerToolsOverride } from "./local-tools.ts";

const role = process.argv[2] ?? "a";
const owner = role.toUpperCase();
const job = JSON.parse(process.env.SPIKE_JOB!) as { tenantId: string; turnId: string; botId: string };
const workspace = process.env.SPIKE_WORKSPACE ?? "/workspace";

const scripted = new ScriptedProvider("openai", "scripted-model");
if (role === "a") {
	scripted.toolCall("write_workspace", { path: "/workspace/notes.md", content: "draft-one\n" }, "I will write the notes file.");
} else if (role === "b") {
	scripted.callCount = 100;
	scripted
		.toolCall("run_terminal", { command: "ls -l /workspace && cat /workspace/notes.md && cat /etc/os-release | head -1 && git --version" }, "Let me look around.")
		.toolCall("write_workspace", { path: "/workspace/notes.md", content: "draft-two\n" }, "Now I revise it.")
		.reply("Done. notes.md now says draft-two.");
} else {
	scripted.callCount = 200;
	scripted.reply("I wrote notes.md, listed the workspace and revised the file.");
}

async function main(): Promise<void> {
	const started = performance.now();
	const baseDeps = buildExecutorDeps(
		`${owner}`,
		scriptedModels(scripted.provider),
		{ provider: "openai", modelId: "scripted-model", thinkingLevel: "off" },
		role === "b" ? undefined : () => Number.MAX_SAFE_INTEGER,
	);
	const deps = baseDeps;
	journal(owner, "executor.start", { turnId: job.turnId, lambdaRemainingTimeProbe: role !== "b" });
	if (role === "b") {
		const waiting = await getTurn(deps.turns, job.tenantId, job.turnId);
		journal(owner, "turn.before_resume", {
			status: waiting.status,
			waitingFor: waiting.waitingFor,
			attemptId: waiting.attemptId,
			pendingComputerTool: waiting.pendingComputerTool?.toolName,
		});
		const resumed = await resumeTurnForAction(
			{ turns: deps.turns, messaging: deps.messaging, turnRuns: deps.turnRuns, turnProbes: deps.turnProbes, computer: deps.computer },
			job.tenantId,
			job.turnId,
			waiting.pendingComputerTool!.actionId,
		);
		journal(owner, "turn.resumed", { resumed });
		const { consumeRunJob: seamed } = (await import("../generated/executor-seamed.ts")) as { consumeRunJob: typeof consumeRunJob };
		(deps as unknown as { computerToolsOverride: unknown }).computerToolsOverride = localComputerToolsOverride({
			root: workspace,
			workerId: "container-owner-b",
			owner,
			deps,
			tenantId: job.tenantId,
			turnId: job.turnId,
		});
		const outcome = await seamed(job, deps, async () => journal(owner, "sqs.TurnRuns.ack", {}));
		await report(owner, deps, outcome, started);
	} else {
		const outcome = await consumeRunJob(job, deps, async () => journal(owner, "sqs.TurnRuns.ack", {}));
		await report(owner, deps, outcome, started);
		if (role === "a2") {
			const requests = scripted.requests.map((raw) => JSON.parse(raw) as { messages?: Array<{ role: string; content: unknown }> });
			const messages = requests[0]?.messages ?? [];
			journal(owner, "model.request.history", {
				roles: messages.map((message) => message.role),
				toolResults: messages.filter((message) => message.role === "toolResult").map((message) => JSON.stringify(message.content).slice(0, 220)),
			});
		}
	}
	deps.client.destroy();
}

async function report(label: string, deps: ReturnType<typeof buildExecutorDeps>, outcome: string, started: number): Promise<void> {
	const turn = await getTurn(deps.turns, job.tenantId, job.turnId);
	const actions = await deps.computer.actions.listForTurn(job.tenantId, job.turnId);
	journal(label, "executor.outcome", {
		outcome,
		ms: Math.round(performance.now() - started),
		turn: { status: turn.status, waitingFor: turn.waitingFor, attempt: turn.attempt, storageFence: (turn as { storageFence?: number }).storageFence },
		actions: actions.map((action) => ({ tool: action.toolName, status: action.status, claimedBy: action.claimedBy, isError: action.resultIsError, result: action.result?.slice(0, 120) })),
		queuedRunJobs: deps.runJobs.length,
	});
	journal(label, "aws.surface", { calls: awsSurface() });
}

void BACKGROUND_CONTEXT;
main().then(
	() => process.exit(0),
	(error: unknown) => {
		journal(owner, "owner.error", { name: (error as Error).name, message: (error as Error).message, stack: (error as Error).stack?.split("\n").slice(0, 8) });
		process.exit(1);
	},
);
