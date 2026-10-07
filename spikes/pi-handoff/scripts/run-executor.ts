/**
 * Phase 1, executor scenario (Q3 and Q5 through the production turn executor): coordinator that seeds a bot, a channel
 * and a message, then runs separate processes A (park), B (local tools) and A2 (follow-up turn).
 *
 * Usage: node scripts/run-executor.ts
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPiSessionBucket, createPiSessionTable } from "../../../conversation/src/storage/table-definition.ts";
import { createMessagingTable } from "../../../conversation/features-support/messaging-table.ts";
import { commitObjects, dynamoClient, fenceRanges, MESSAGING_TABLE, PI_BUCKET, PI_TABLE, s3Client } from "../src/common.ts";
import { postHumanMessage, seedBotAndChannel, TENANT_ID } from "../src/executor-world.ts";
import { TaskCapabilityGrant } from "../../../conversation/src/policy/capability-policy.ts";
import { DynamoTurnControlStore } from "../../../conversation/src/store/turn-store.ts";
import { storageIdFor } from "../../../conversation/src/storage/storage-support.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ownerScript = join(here, "..", "src", "owner-executor.ts");

const client = dynamoClient();
const s3 = s3Client();
try {
	await createMessagingTable(client, MESSAGING_TABLE);
} catch (error) {
	if ((error as Error).name !== "ResourceInUseException") throw error;
}
await createPiSessionTable(client, PI_TABLE);
await createPiSessionBucket(s3, PI_BUCKET);

const { botId, channelId, deps } = await seedBotAndChannel();
const workspace = join("/tmp", `spike-executor-workspace-${Date.now()}`);
rmSync(workspace, { recursive: true, force: true });
mkdirSync(workspace, { recursive: true });
const journalDirectory = join("/tmp", `spike-executor-journal-${Date.now()}`);
mkdirSync(journalDirectory, { recursive: true });
const journalPath = join(journalDirectory, "journal.jsonl");
const dockerImage = process.env.SPIKE_B_DOCKER;
const dockerNetwork = process.env.SPIKE_DOCKER_NETWORK;
const containerEndpoint = process.env.SPIKE_CONTAINER_ENDPOINT ?? (dockerNetwork === undefined ? "http://host.docker.internal:5622" : "http://moto-spike:5000");

const run = (role: string, job: object): void => {
	if (role === "b" && dockerImage !== undefined) {
		const name = `spike-exec-b-${Date.now()}`;
		const started = Date.now();
		const result = spawnSync(
			"docker",
			["run", "--name", name, ...(dockerNetwork === undefined ? [] : ["--network", dockerNetwork]), "-e", `CHATTICUS_TEST_AWS_ENDPOINT=${containerEndpoint}`, "-e", `SPIKE_JOB=${JSON.stringify(job)}`, "-e", "SPIKE_JOURNAL=/journal/journal.jsonl", "-e", "SPIKE_ENTRY=owner-executor", "-e", `SPIKE_NO_KEEPALIVE=${process.env.SPIKE_NO_KEEPALIVE ?? "0"}`, "-v", `${journalDirectory}:/journal`, dockerImage],
			{ encoding: "utf8", timeout: 180_000 },
		);
		console.log(`docker run exit ${result.status}, wall ${Date.now() - started} ms\n${result.stdout}${result.stderr}`);
		console.log(`docker cp notes.md: ${JSON.stringify(spawnSync("sh", ["-c", `docker cp ${name}:/workspace/notes.md - | tar -xO`], { encoding: "utf8" }).stdout)}`);
		spawnSync("docker", ["rm", "-f", name]);
		return;
	}
	const result = spawnSync("node", [ownerScript, role], {
		env: { ...process.env, SPIKE_JOB: JSON.stringify(job), SPIKE_JOURNAL: journalPath, SPIKE_WORKSPACE: workspace },
		encoding: "utf8",
		timeout: 120_000,
	});
	if (result.status !== 0) console.log(`process ${role} exit ${result.status}\n${result.stdout}\n${result.stderr}`);
};

const first = await postHumanMessage(deps, channelId, botId, "Write notes.md in /workspace, then look around and revise it.");
const turnStore = new DynamoTurnControlStore(client, MESSAGING_TABLE);
await turnStore.replaceGrant({
	tenantId: TENANT_ID,
	turnId: first.turnId,
	grant: new TaskCapabilityGrant(new Set(["read_workspace", "write_workspace", "run_terminal"]), new Set(), new Set(), new Set(["/workspace"]), new Set(), new Set()),
	body: JSON.stringify({ actor_user_id: "ryan", tools: ["read_workspace", "run_terminal", "write_workspace"] }),
	eventId: randomUUID(),
	expiresAt: new Date(Date.now() + 86_400_000),
});
run("a", first);
run("b", first);
const second = await postHumanMessage(deps, channelId, botId, "What did you just do?");
run("a2", second);

for (const line of readFileSync(journalPath, "utf8").trim().split("\n")) {
	const { at, pid, ...rest } = JSON.parse(line) as Record<string, unknown>;
	console.log(`${String(at).slice(11, 23)} pid=${pid} ${JSON.stringify(rest)}`);
}
const commits = await commitObjects(s3, storageIdFor(TENANT_ID, botId, channelId));
console.log("storage commits by fence:", fenceRanges(commits));
console.log(`workspace ${workspace}:`);
console.log(spawnSync("sh", ["-c", `ls -l ${workspace}; cat ${workspace}/notes.md`], { encoding: "utf8" }).stdout);
client.destroy();
s3.destroy();
