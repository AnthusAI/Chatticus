import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { linkSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { Given, Then, When } from "@cucumber/cucumber";
import * as tar from "tar";
import { WORKSPACE_DIRNAME } from "../../src/browser-profiles.ts";
import { packLiveDisk, unpackLiveDisk } from "../../src/snapshot/pack.ts";
import type { ChatticusWorld } from "../world.ts";

type HandmadeEntry = {
	readonly path: string;
	readonly type: "File" | "Directory" | "SymbolicLink" | "Link" | "FIFO" | "CharacterDevice";
	readonly content?: string;
	readonly linkpath?: string;
	readonly mode?: number;
};

type RestoreSafetyScenario = {
	liveRoot: string;
	freshRoot: string;
	handmade: HandmadeEntry[];
	refusal: string | null;
};

const scenarios = new WeakMap<ChatticusWorld, RestoreSafetyScenario>();

function scenarioOf(world: ChatticusWorld): RestoreSafetyScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		assert.ok(world.snapshotTmpdir, "The scenario has no temporary directory.");
		const root = join(world.snapshotTmpdir, "restore-safety");
		scenario = {
			liveRoot: join(root, "live"),
			freshRoot: join(root, "fresh"),
			handmade: [{ path: WORKSPACE_DIRNAME, type: "Directory", mode: 0o755 }],
			refusal: null,
		};
		for (const directory of [scenario.liveRoot, scenario.freshRoot]) mkdirSync(join(directory, WORKSPACE_DIRNAME), { recursive: true });
		scenarios.set(world, scenario);
	}
	return scenario;
}

const inWorkspace = (root: string, name: string): string => join(root, WORKSPACE_DIRNAME, name);

function writeIn(root: string, name: string, content: string): void {
	const path = inWorkspace(root, name);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

const BLOCK = 512;

function handmadePackOf(entries: readonly HandmadeEntry[]): Buffer {
	const parts: Buffer[] = [];
	for (const entry of entries) {
		const data = Buffer.from(entry.content ?? "", "utf8");
		const header = new tar.Header({
			path: entry.path,
			type: entry.type,
			mode: entry.mode ?? 0o644,
			size: data.length,
			...(entry.linkpath === undefined ? {} : { linkpath: entry.linkpath }),
		});
		header.encode();
		parts.push(Buffer.from(header.block as Buffer));
		if (data.length > 0) {
			parts.push(data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK));
		}
	}
	parts.push(Buffer.alloc(BLOCK * 2));
	return gzipSync(Buffer.concat(parts));
}

function hold(world: ChatticusWorld, entry: HandmadeEntry): void {
	scenarioOf(world).handmade.push({ ...entry, path: `${WORKSPACE_DIRNAME}/${entry.path}` });
}

Given("a live disk with workspace file {string} containing {string}", function (this: ChatticusWorld, name: string, content: string) {
	writeIn(scenarioOf(this).liveRoot, name, content);
});

Given("a handmade pack holding a workspace symbolic link {string} to {string}", function (this: ChatticusWorld, name: string, target: string) {
	hold(this, { path: name, type: "SymbolicLink", linkpath: target });
});

Given("a handmade pack holding a workspace file {string} containing {string}", function (this: ChatticusWorld, name: string, content: string) {
	hold(this, { path: name, type: "File", content });
});

Given("the handmade pack holds a workspace file {string} containing {string}", function (this: ChatticusWorld, name: string, content: string) {
	hold(this, { path: name, type: "File", content });
});

Given("a handmade pack holding a workspace hard link {string} to {string}", function (this: ChatticusWorld, name: string, target: string) {
	hold(this, { path: name, type: "Link", linkpath: target });
});

Given("the handmade pack holds a workspace hard link {string} to {string}", function (this: ChatticusWorld, name: string, target: string) {
	hold(this, { path: name, type: "Link", linkpath: target });
});

Given("a handmade pack holding a workspace named pipe {string}", function (this: ChatticusWorld, name: string) {
	hold(this, { path: name, type: "FIFO" });
});

Given("a handmade pack holding a workspace character device {string}", function (this: ChatticusWorld, name: string) {
	hold(this, { path: name, type: "CharacterDevice" });
});

Given("a handmade pack holding a setuid workspace file {string}", function (this: ChatticusWorld, name: string) {
	hold(this, { path: name, type: "File", content: "#!/bin/sh\n", mode: 0o4755 });
});

Given("the handmade pack holds a setgid workspace directory {string}", function (this: ChatticusWorld, name: string) {
	hold(this, { path: name, type: "Directory", mode: 0o2755 });
});

When("the handmade pack is restored onto the live disk", async function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	try {
		await unpackLiveDisk(handmadePackOf(scenario.handmade), scenario.liveRoot);
	} catch (error) {
		scenario.refusal = error instanceof Error ? error.message : String(error);
	}
});

Given(
	"a live disk with a workspace file {string} containing {string} and a second hard link {string}",
	function (this: ChatticusWorld, name: string, content: string, second: string) {
		const scenario = scenarioOf(this);
		writeIn(scenario.liveRoot, name, content);
		linkSync(inWorkspace(scenario.liveRoot, name), inWorkspace(scenario.liveRoot, second));
	},
);

Given("the live disk has a workspace named pipe {string}", function (this: ChatticusWorld, name: string) {
	execFileSync("mkfifo", [inWorkspace(scenarioOf(this).liveRoot, name)]);
});

Given("the live disk has a workspace symbolic link {string} pointing to {string}", function (this: ChatticusWorld, name: string, target: string) {
	symlinkSync(target, inWorkspace(scenarioOf(this).liveRoot, name));
});

When("the live disk is packed and restored onto a fresh disk", async function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	await unpackLiveDisk(await packLiveDisk(scenario.liveRoot), scenario.freshRoot);
});

Then("the restore is refused mentioning {string}", function (this: ChatticusWorld, text: string) {
	const scenario = scenarioOf(this);
	assert.ok(scenario.refusal !== null, "The restore was not refused.");
	assert.ok(scenario.refusal.includes(text), scenario.refusal);
});

Then("the live disk still has workspace file {string} containing {string}", function (this: ChatticusWorld, name: string, content: string) {
	assert.equal(readFileSync(inWorkspace(scenarioOf(this).liveRoot, name), "utf8"), content);
});

Then("the restored workspace file {string} contains {string}", function (this: ChatticusWorld, name: string, content: string) {
	assert.equal(readFileSync(inWorkspace(scenarioOf(this).liveRoot, name), "utf8"), content);
});

Then("the restored workspace has a symbolic link {string} pointing to {string}", function (this: ChatticusWorld, name: string, target: string) {
	const path = inWorkspace(scenarioOf(this).liveRoot, name);
	assert.ok(lstatSync(path).isSymbolicLink(), `${name} is not a link`);
	assert.equal(readlinkSync(path), target);
});

Then("the restored workspace file {string} is not setuid", function (this: ChatticusWorld, name: string) {
	const mode = lstatSync(inWorkspace(scenarioOf(this).liveRoot, name)).mode;
	assert.equal(mode & 0o7000, 0, `The mode is ${(mode & 0o7777).toString(8)}`);
});

Then("the fresh disk has workspace file {string} containing {string}", function (this: ChatticusWorld, name: string, content: string) {
	const path = inWorkspace(scenarioOf(this).freshRoot, name);
	assert.ok(lstatSync(path).isFile(), `${name} is not a regular file`);
	assert.equal(readFileSync(path, "utf8"), content);
});

Then("the fresh disk has a workspace symbolic link {string} pointing to {string}", function (this: ChatticusWorld, name: string, target: string) {
	const path = inWorkspace(scenarioOf(this).freshRoot, name);
	assert.ok(lstatSync(path).isSymbolicLink(), `${name} is not a link`);
	assert.equal(readlinkSync(path), target);
});

Then("the fresh disk has no workspace entry {string}", function (this: ChatticusWorld, name: string) {
	assert.throws(() => lstatSync(inWorkspace(scenarioOf(this).freshRoot, name)), `The fresh disk has ${name}.`);
});
