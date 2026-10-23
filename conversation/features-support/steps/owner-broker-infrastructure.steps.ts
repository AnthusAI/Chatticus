import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Given, Then } from "@cucumber/cucumber";
import type { ChatticusWorld } from "../world.ts";

const execFileAsync = promisify(execFile);
const INFRA_DIRECTORY = fileURLToPath(new URL("../../../infra", import.meta.url));
const HARNESS_PATH = fileURLToPath(new URL("../../../infra/test/control-plane-broker-harness.ts", import.meta.url));
const TSX_PATH = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
const RESULT_MARKER = "HARNESS_RESULT ";

type Statement = Record<string, any>;

type SynthesisResult = {
	readonly outcome: "synthesized" | "failed";
	readonly message?: string;
	readonly templateText?: string;
	readonly brokerExists?: boolean;
	readonly brokerEnvironment?: Record<string, unknown> | null;
	readonly brokerRoleLogicalId?: string | null;
	readonly brokerStatements?: Statement[];
	readonly supervisorTrust?: Statement[] | null;
	readonly supervisorMaxSessionDuration?: number | null;
	readonly scopedTrust?: Statement[] | null;
	readonly scopedMaxSessionDuration?: number | null;
	readonly roleLogicalIds?: { scoped: string | null; supervisor: string | null };
};

const SYNTHESIS_STEP_TIMEOUT_MILLISECONDS = 120_000;

const results = new WeakMap<ChatticusWorld, SynthesisResult>();
const synthesisByVariant = new Map<string, Promise<SynthesisResult>>();

async function runHarness(environment: string, withSwitch: boolean): Promise<SynthesisResult> {
	const { stdout } = await execFileAsync(TSX_PATH, [HARNESS_PATH, environment, withSwitch ? "with-switch" : "without-switch"], {
		cwd: INFRA_DIRECTORY,
		maxBuffer: 128 * 1024 * 1024,
	});
	const line = stdout.split("\n").find((candidate) => candidate.startsWith(RESULT_MARKER));
	assert.ok(line, "The infra harness printed no result.");
	return JSON.parse(line.slice(RESULT_MARKER.length)) as SynthesisResult;
}

async function synthesize(world: ChatticusWorld, environment: string, withSwitch: boolean): Promise<void> {
	const variant = `${environment}:${withSwitch}`;
	let synthesis = synthesisByVariant.get(variant);
	if (!synthesis) {
		synthesis = runHarness(environment, withSwitch);
		synthesisByVariant.set(variant, synthesis);
		synthesis.catch(() => synthesisByVariant.delete(variant));
	}
	results.set(world, await synthesis);
}

function synthesized(world: ChatticusWorld): SynthesisResult {
	const result = results.get(world);
	assert.ok(result, "No control plane stack was synthesized in this scenario.");
	return result;
}

function actionsOf(statement: Statement): string[] {
	return Array.isArray(statement.Action) ? statement.Action : [statement.Action];
}

Given("the synthesized control plane stack", { timeout: SYNTHESIS_STEP_TIMEOUT_MILLISECONDS }, async function (this: ChatticusWorld) {
	await synthesize(this, "development", false);
	assert.equal(synthesized(this).outcome, "synthesized", synthesized(this).message);
});

Given("the control plane stack synthesized for {word}", { timeout: SYNTHESIS_STEP_TIMEOUT_MILLISECONDS }, async function (this: ChatticusWorld, environment: string) {
	await synthesize(this, environment, false);
	assert.equal(synthesized(this).outcome, "synthesized", synthesized(this).message);
});

Given("the control plane stack synthesized for {word} with the broker fault switch set", { timeout: SYNTHESIS_STEP_TIMEOUT_MILLISECONDS }, async function (this: ChatticusWorld, environment: string) {
	await synthesize(this, environment, true);
});

Then("the broker's role holds the permission to read the signing key and to assume the two owner roles and nothing else", function (this: ChatticusWorld) {
	const result = synthesized(this);
	const statements = result.brokerStatements ?? [];
	assert.equal(statements.length, 2);
	const parameter = statements.find((statement) => actionsOf(statement).includes("ssm:GetParameter"));
	assert.ok(parameter);
	assert.deepEqual(actionsOf(parameter), ["ssm:GetParameter"]);
	assert.match(JSON.stringify(parameter.Resource), /parameter\/chatticus\/development\/model-gateway\/signing-key/);
	assert.equal(statements.some((statement) => actionsOf(statement).some((action) => action.startsWith("secretsmanager:"))), false);
	const assume = statements.find((statement) => actionsOf(statement).includes("sts:AssumeRole"));
	assert.ok(assume);
	assert.deepEqual(actionsOf(assume).sort(), ["sts:AssumeRole", "sts:TagSession"]);
	assert.deepEqual(assume.Resource, [
		{ "Fn::GetAtt": [result.roleLogicalIds?.scoped, "Arn"] },
		{ "Fn::GetAtt": [result.roleLogicalIds?.supervisor, "Arn"] },
	]);
	assert.equal(assume.Condition, undefined);
});

function assertTrustsOnlyTheBroker(result: SynthesisResult, trust: Statement[] | null | undefined, tagKeys: string[]): void {
	assert.ok(trust, "The role was not synthesized.");
	for (const statement of trust) {
		assert.equal(statement.Effect, "Allow");
		assert.deepEqual(statement.Principal, { AWS: { "Fn::GetAtt": [result.brokerRoleLogicalId, "Arn"] } });
	}
	assert.deepEqual([...new Set(trust.flatMap(actionsOf))].sort(), ["sts:AssumeRole", "sts:TagSession"]);
	const requiredNull = Object.fromEntries(tagKeys.map((key) => [`aws:RequestTag/${key}`, "false"]));
	for (const action of ["sts:AssumeRole", "sts:TagSession"]) {
		const statement: Statement | undefined = trust.find((candidate: Statement) => actionsOf(candidate).includes(action));
		assert.ok(statement, `A trust statement allows ${action}.`);
		assert.deepEqual(statement.Condition.Null, requiredNull);
		assert.deepEqual(statement.Condition["ForAllValues:StringEquals"], { "aws:TagKeys": tagKeys });
	}
}

Then("the supervisor role and the per-turn role still trust only the broker's role with their exact session tag keys", function (this: ChatticusWorld) {
	const result = synthesized(this);
	assertTrustsOnlyTheBroker(result, result.supervisorTrust, ["tenant", "computer"]);
	assertTrustsOnlyTheBroker(result, result.scopedTrust, ["tenant", "bot", "channel", "computer", "turn"]);
});

Then("both roles keep a maximum session of {int} seconds", function (this: ChatticusWorld, seconds: number) {
	const result = synthesized(this);
	assert.equal(result.supervisorMaxSessionDuration, seconds);
	assert.equal(result.scopedMaxSessionDuration, seconds);
});

Then("the template names neither {string} nor {string}", function (this: ChatticusWorld, first: string, second: string) {
	const text = synthesized(this).templateText ?? "";
	assert.equal(text.includes(first), false);
	assert.equal(text.includes(second), false);
});

Then("the template holds no owner credential broker", function (this: ChatticusWorld) {
	assert.equal(synthesized(this).brokerExists, false);
});

Then("the broker's environment holds {string} set to {string}", function (this: ChatticusWorld, name: string, value: string) {
	assert.equal(synthesized(this).brokerEnvironment?.[name], value);
});

Then("the broker's environment holds neither {string} nor {string}", function (this: ChatticusWorld, first: string, second: string) {
	const environment = synthesized(this).brokerEnvironment;
	assert.ok(environment, "The template holds no broker.");
	assert.equal(first in environment, false);
	assert.equal(second in environment, false);
});

Then("the synthesis sets the broker's environment", function (this: ChatticusWorld) {
	const result = synthesized(this);
	assert.equal(result.outcome, "synthesized", result.message);
	assert.equal(result.brokerEnvironment?.CHATTICUS_ENVIRONMENT, "development");
	assert.equal(result.brokerEnvironment?.CHATTICUS_OWNER_BROKER_FAULT, "deny_supervisor_renewal");
	assert.equal(result.brokerEnvironment?.CHATTICUS_OWNER_BROKER_CREDENTIAL_SECONDS, "900");
});

Then("the synthesis fails and names the switch", function (this: ChatticusWorld) {
	const result = synthesized(this);
	assert.equal(result.outcome, "failed");
	assert.match(result.message ?? "", /ownerBrokerFault/);
	assert.match(result.message ?? "", /ownerBrokerCredentialSeconds/);
});
