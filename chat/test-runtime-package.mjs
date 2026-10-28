import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repository = process.cwd();
const temporaryDirectory = await mkdtemp(join(tmpdir(), "chatticus-runtime-consumer-"));
const consumerDirectory = join(temporaryDirectory, "consumer");
try {
	execFileSync("npm", ["pack", "--json", "--pack-destination", temporaryDirectory], { cwd: repository, stdio: "ignore" });
	const entries = await readdir(temporaryDirectory);
	const archiveName = entries.find((entry) => entry.endsWith(".tgz"));
	assert.ok(archiveName, "npm pack creates the consumer archive");
	await mkdir(consumerDirectory, { recursive: true });
	await writeFile(join(consumerDirectory, "package.json"), JSON.stringify({ name: "chatticus-runtime-consumer", private: true, type: "module" }));
	execFileSync("npm", [
		"install",
		"--ignore-scripts",
		"--no-audit",
		"--no-fund",
		"--no-save",
		"--package-lock=false",
		"--legacy-peer-deps",
		join(temporaryDirectory, archiveName),
	], { cwd: consumerDirectory, stdio: "inherit" });
	const consumerCode = `
		import assert from "node:assert/strict";
		const server = await import("chatticus/chat-server");
		const worker = await import("chatticus/chat-worker");
		const runtime = await import("chatticus/chat-runtime");
		assert.equal(typeof server.createEmbeddedChatApp, "function");
		assert.equal(typeof worker.consumeRunJob, "function");
		assert.equal(typeof worker.Decimal.parse, "function");
		assert.equal(typeof worker.VendorPriceBook, "function");
		assert.equal(typeof runtime.createSiteHostedChatDependencies, "function");
		assert.equal(typeof runtime.createSiteHostedRunHandler, "function");
		assert.equal(typeof runtime.createSiteHostedProbeHandler, "function");
		console.log("PASS: clean consumer loads compiled Chatticus server and worker exports");
	`;
	execFileSync(process.execPath, ["--input-type=module", "-e", consumerCode], { cwd: consumerDirectory, stdio: "inherit" });
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
