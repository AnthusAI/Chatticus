import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Given, Then } from "@cucumber/cucumber";
import { computerOwnerScenarioOf } from "../computer-owner.ts";
import { modelScenarioOf } from "../executor-harness.ts";
import type { ChatticusWorld } from "../world.ts";

const outsideDirectoryOf = (world: ChatticusWorld): string => {
	assert.ok(world.snapshotTmpdir, "The scenario has no temporary directory.");
	const directory = join(world.snapshotTmpdir, "outside");
	mkdirSync(directory, { recursive: true });
	return directory;
};

const workspaceEntryOf = (world: ChatticusWorld, name: string): string => join(computerOwnerScenarioOf(world).workspace, name);

Given("a file {string} outside the workspace containing {string}", function (this: ChatticusWorld, name: string, content: string) {
	writeFileSync(join(outsideDirectoryOf(this), name), content);
});

Given("the workspace has a symbolic link {string} to the outside file {string}", function (this: ChatticusWorld, link: string, target: string) {
	symlinkSync(join(outsideDirectoryOf(this), target), workspaceEntryOf(this, link));
});

Given("the workspace has a symbolic link {string} to the outside directory", function (this: ChatticusWorld, link: string) {
	symlinkSync(outsideDirectoryOf(this), workspaceEntryOf(this, link));
});

Given("the workspace has a symbolic link {string} to the workspace path {string}", function (this: ChatticusWorld, link: string, target: string) {
	symlinkSync(workspaceEntryOf(this, target), workspaceEntryOf(this, link));
});

Then("the outside file {string} still contains {string}", function (this: ChatticusWorld, name: string, content: string) {
	assert.equal(readFileSync(join(outsideDirectoryOf(this), name), "utf8"), content);
});

Then("the outside directory has no file {string}", function (this: ChatticusWorld, name: string) {
	assert.equal(existsSync(join(outsideDirectoryOf(this), name)), false, `The outside directory has ${name}.`);
});

Then("the model's next request does not contain {string}", function (this: ChatticusWorld, text: string) {
	const requests = modelScenarioOf(this).scripted.requests;
	assert.ok(requests.length >= 2, `The model was asked ${requests.length} times`);
	assert.ok(!requests[requests.length - 1]!.includes(text), `The model saw ${JSON.stringify(text)}`);
});
