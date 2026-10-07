/**
 * Raw scenario: separate Node processes (A, B, A2) over one pi-durable storage on moto.
 *
 * Usage:
 *   SPIKE_MODEL=faux node scripts/run-raw.ts [variant ...]     variants: safe unsafe missing schema
 *   SPIKE_B_DOCKER=pi-handoff-spike:phase2 node scripts/run-raw.ts safe      owner B runs in a container (phase 2)
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPiSessionBucket, createPiSessionTable } from "../../../conversation/src/storage/table-definition.ts";
import { dynamoClient, PI_BUCKET, PI_TABLE, s3Client } from "../src/common.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ownerScript = join(here, "..", "src", "owner-raw.ts");
const variants = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["safe"];
const dockerImage = process.env.SPIKE_B_DOCKER;
const dockerNetwork = process.env.SPIKE_DOCKER_NETWORK;
const containerEndpoint = process.env.SPIKE_CONTAINER_ENDPOINT ?? (dockerNetwork === undefined ? "http://host.docker.internal:5622" : "http://moto-spike:5000");
const networkArguments = dockerNetwork === undefined ? [] : ["--network", dockerNetwork];

const client = dynamoClient();
const s3 = s3Client();
await createPiSessionTable(client, PI_TABLE);
await createPiSessionBucket(s3, PI_BUCKET);

for (const variant of variants) {
	const stamp = Date.now();
	const storageId = `spike#bot-${variant}#channel-${stamp}`;
	const workspace = join("/tmp", `spike-workspace-${variant}-${stamp}`);
	rmSync(workspace, { recursive: true, force: true });
	mkdirSync(workspace, { recursive: true });
	const journalDirectory = join("/tmp", `spike-journal-${variant}-${stamp}`);
	mkdirSync(journalDirectory, { recursive: true });
	const journalPath = join(journalDirectory, "journal.jsonl");
	const environment = {
		...process.env,
		SPIKE_STORAGE_ID: storageId,
		SPIKE_JOURNAL: journalPath,
		SPIKE_WORKSPACE: workspace,
		SPIKE_B_VARIANT: variant,
	};
	console.log(`\n===== variant ${variant} (storage ${storageId})${dockerImage === undefined ? "" : ` owner B in container ${dockerImage}`} =====`);
	let containerStartedAt = 0;
	let containerName = "";
	for (const role of ["a", "b", "a2"]) {
		if (role === "a2" && variant !== "safe") continue;
		if (role === "b" && dockerImage !== undefined) {
			containerName = `spike-b-${stamp}`;
			containerStartedAt = Date.now();
			const run = spawnSync(
				"docker",
				[
					"run",
					"--name",
					containerName,
					...networkArguments,
					"-e",
					`CHATTICUS_TEST_AWS_ENDPOINT=${containerEndpoint}`,
					"-e",
					`SPIKE_NO_KEEPALIVE=${process.env.SPIKE_NO_KEEPALIVE ?? "0"}`,
					"-e",
					`SPIKE_STORAGE_ID=${storageId}`,
					"-e",
					"SPIKE_JOURNAL=/journal/journal.jsonl",
					"-e",
					`SPIKE_B_VARIANT=${variant}`,
					"-e",
					`SPIKE_MODEL=${process.env.SPIKE_MODEL ?? "faux"}`,
					"-e",
					`SPIKE_ENTRY=${process.env.SPIKE_ENTRY ?? "owner-raw"}`,
					"-v",
					`${journalDirectory}:/journal`,
					dockerImage,
				],
				{ encoding: "utf8", timeout: 180_000 },
			);
			console.log(`docker run exit ${run.status}, wall ${Date.now() - containerStartedAt} ms\n${run.stdout}${run.stderr}`);
			continue;
		}
		const run = spawnSync("node", [ownerScript, role], { env: environment, encoding: "utf8", timeout: 120_000 });
		if (run.status !== 0) console.log(`process ${role} exit ${run.status}\n${run.stdout}\n${run.stderr}`);
	}
	const lines = readFileSync(journalPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
	for (const entry of lines) {
		const { at, ...rest } = entry;
		console.log(`${String(at).slice(11, 23)} ${JSON.stringify(rest)}`);
	}
	if (dockerImage !== undefined) {
		const at = (owner: string, event: string): number => {
			const found = lines.find((entry) => entry.owner === owner && entry.event === event);
			return found === undefined ? Number.NaN : Date.parse(String(found.at));
		};
		const boot = at("B", "owner.boot");
		const open = at("B", "owner.open");
		const firstTool = at("B", "tool.run.local");
		const firstResult = at("B", "event.tool_execution_end");
		console.log(
			`cold start (ms): docker run to node start ${boot - containerStartedAt}, node start to storage open ${open - boot}, ` +
				`storage open to first tool result ${firstResult - open} (tool began ${firstTool - open}), docker run to first tool result ${firstResult - containerStartedAt}`,
		);
		const copied = spawnSync("sh", ["-c", `docker cp ${containerName}:/workspace/hello.txt - | tar -xO`], { encoding: "utf8" });
		console.log(`docker cp of the file on the container disk: ${JSON.stringify(copied.stdout)}`);
		console.log(`file on the host workspace dir (must stay empty): ${JSON.stringify(spawnSync("ls", ["-A", workspace], { encoding: "utf8" }).stdout)}`);
		spawnSync("docker", ["rm", "-f", containerName]);
	} else {
		console.log(`workspace ${workspace}:\n${spawnSync("ls", ["-l", workspace], { encoding: "utf8" }).stdout}`);
		console.log(`hello.txt: ${spawnSync("sh", ["-c", `cat ${workspace}/hello.txt 2>&1`], { encoding: "utf8" }).stdout.trim()}`);
	}
}
client.destroy();
s3.destroy();
