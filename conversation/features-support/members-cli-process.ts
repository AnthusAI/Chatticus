import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ChatticusWorld } from "./world.ts";

const MEMBERS_BIN_PATH = fileURLToPath(new URL("../bin/members.ts", import.meta.url));

/** The observable outcome of one members CLI subprocess. */
export interface MembersCliProcessResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

/**
 * Run the real members CLI as a subprocess against the scenario's messaging table, with real argv, stdout and
 * exit code, and remember the outcome on the world.
 */
export async function runMembersCliProcess(world: ChatticusWorld, argv: string[]): Promise<MembersCliProcessResult> {
	const child = spawn(process.execPath, [MEMBERS_BIN_PATH, ...argv], {
		env: {
			...process.env,
			CHATTICUS_MESSAGING_TABLE: world.messagingTable.tableName,
			AWS_ENDPOINT_URL: process.env.CHATTICUS_TEST_AWS_ENDPOINT ?? "http://127.0.0.1:5555",
			AWS_REGION: "us-east-1",
			AWS_ACCESS_KEY_ID: "test",
			AWS_SECRET_ACCESS_KEY: "test",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
	const exitCode = await new Promise<number | null>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", resolve);
	});
	const result = { exitCode, stdout, stderr };
	world.membersCliResult = result;
	return result;
}

/** Run the CLI and require exit code 0, reporting both streams on failure. */
export async function runMembersCliExpectingSuccess(world: ChatticusWorld, argv: string[]) {
	const result = await runMembersCliProcess(world, argv);
	assert.equal(result.exitCode, 0, `members ${argv[0]} exited ${result.exitCode}: ${result.stderr}${result.stdout}`);
	return result;
}

/** Parse the key=value pairs of one CLI confirmation line such as "enabled tenant_id=x status=enabled". */
export function parseConfirmationLine(stdout: string, verb: string): Record<string, string> {
	const line = stdout.split("\n").find((candidate) => candidate.startsWith(`${verb} `));
	assert.ok(line, `no "${verb}" line in the CLI output: ${JSON.stringify(stdout)}`);
	return Object.fromEntries(
		line
			.slice(verb.length + 1)
			.split(" ")
			.map((pair) => {
				const separator = pair.indexOf("=");
				return [pair.slice(0, separator), pair.slice(separator + 1)];
			}),
	);
}

/** Create one pending organization through the CLI and register the owner and organization in the world. */
export async function createOrganizationThroughCli(world: ChatticusWorld, name: string, email: string): Promise<void> {
	const result = await runMembersCliExpectingSuccess(world, ["create", "--owner-email", email, "--name", name, "--yes"]);
	const confirmation = parseConfirmationLine(result.stdout, "created");
	assert.equal(confirmation.status, "pending");
	const store = world.messagingStore();
	const organization = await store.getOrganization(confirmation.tenant_id);
	assert.ok(organization, `organization ${confirmation.tenant_id} is not in the store`);
	assert.equal(organization.name, name);
	const identity = await store.getIdentityByEmail(email.trim().toLowerCase());
	assert.ok(identity, `no identity for ${email} after the CLI created the organization`);
	assert.equal(identity.userId, confirmation.owner);
	world.orgsByName?.set(name, organization);
	world.currentIdentity = identity;
	world.identitiesByEmail?.set(email, identity);
}

