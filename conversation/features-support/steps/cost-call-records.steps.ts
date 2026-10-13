import { Given, When } from "@cucumber/cucumber";
import { createGatewayModels } from "../../../computer/host/src/owner-models.ts";
import { mintSessionToken } from "../../src/gateway/session-token.ts";
import { takeOverTurn } from "../../src/turn/computer-owner.ts";
import { activeTurnJob, computerOwnerDepsFor, computerOwnerScenarioOf } from "../computer-owner.ts";
import { modelScenarioOf } from "../executor-harness.ts";
import { httpBaseUrl } from "../front-door.ts";
import { SCENARIO_GATEWAY_SIGNING_KEY } from "../model-gateway-support.ts";
import type { ChatticusWorld } from "../world.ts";

const GATEWAY_MODEL_ID = "gpt-5-nano";
const GATEWAY_TOKEN_SECONDS = 600;

Given(
	"the model is scripted to answer {string} using {int} input tokens and {int} output tokens",
	function (this: ChatticusWorld, text: string, inputTokens: number, outputTokens: number) {
		modelScenarioOf(this).scripted.reply(text, { input: inputTokens, output: outputTokens });
	},
);

When("computer owner {string} takes over the turn through the model gateway", async function (this: ChatticusWorld, label: string) {
	const job = activeTurnJob(this);
	const workerId = `computer-owner-${label}`;
	const token = mintSessionToken(SCENARIO_GATEWAY_SIGNING_KEY, {
		audience: "model-gateway",
		startGeneration: 1,
		tenantId: job.tenantId,
		botId: job.botId,
		turnId: job.turnId,
		ownerId: workerId,
		expiresAtSeconds: Math.floor(this.clock.now().getTime() / 1000) + GATEWAY_TOKEN_SECONDS,
	});
	const baseUrl = `${await httpBaseUrl(this)}/orgs/${job.tenantId}/model-gateway/v1`;
	const scriptedDeps = await computerOwnerDepsFor(this);
	const deps = {
		...scriptedDeps,
		models: createGatewayModels({ baseUrl, token }),
		model: { provider: "openai", modelId: GATEWAY_MODEL_ID, thinkingLevel: "minimal" as const },
	};
	const scenario = computerOwnerScenarioOf(this);
	const outcome = await takeOverTurn(job, deps, { workspaceRoot: scenario.workspace, workerId });
	scenario.outcomes.set(label, outcome);
});
