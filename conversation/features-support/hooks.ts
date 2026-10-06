import { After, AfterAll, Before, setDefaultTimeout } from "@cucumber/cucumber";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existingModelScenario } from "./executor-harness.ts";
import { dropPiStorage } from "./pi-storage.ts";
import type { ChatticusWorld } from "./world.ts";

const scenarioTimes: number[] = [];

setDefaultTimeout(20_000);

Before(async function (this: ChatticusWorld) {
	this.scenarioStartTime = Date.now();
	await this.messagingTable.create();
	this.snapshotTmpdir = mkdtempSync(join(tmpdir(), "chatticus-snapshot-"));
});

After(async function (this: ChatticusWorld) {
	await existingModelScenario(this)?.watcher?.disconnect();
	if (this.httpServer) {
		await this.httpServer.close();
	}
	await dropPiStorage(this);
	await this.messagingTable.drop();
	this.messagingTable.client.destroy();

	if (this.snapshotTmpdir) {
		rmSync(this.snapshotTmpdir, { recursive: true, force: true });
	}

	const scenarioEndTime = Date.now();
	const duration = scenarioEndTime - this.scenarioStartTime;
	scenarioTimes.push(duration);
});

AfterAll(function () {
	if (scenarioTimes.length > 0) {
		const sorted = scenarioTimes.sort((a, b) => a - b);
		const p95Index = Math.ceil(sorted.length * 0.95) - 1;
		const p95 = sorted[Math.max(0, p95Index)];
		console.log(`scenario p95 ms: ${p95}`);
	}
});
