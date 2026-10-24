import { build } from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const outputDirectory = resolve("chat/runtime-dist");
const hostProtocolDirectory = resolve("host-protocol/src");
const aliases = {
	"@chatticus/host-protocol": resolve(hostProtocolDirectory, "schemas.ts"),
	"@chatticus/host-protocol/costs": resolve(hostProtocolDirectory, "costs.ts"),
	"@chatticus/host-protocol/edit-overlay": resolve(hostProtocolDirectory, "edit-overlay.ts"),
	"@chatticus/host-protocol/live-file-rules": resolve(hostProtocolDirectory, "live-file-rules.ts"),
	"@chatticus/host-protocol/live-files": resolve(hostProtocolDirectory, "live-files.ts"),
	"@chatticus/host-protocol/supervisor": resolve(hostProtocolDirectory, "supervisor.ts"),
	"@chatticus/host-protocol/workspace-edit": resolve(hostProtocolDirectory, "workspace-edit.ts"),
};

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await build({
	absWorkingDir: process.cwd(),
	entryPoints: {
		"chat-server": "conversation/src/http/embedded-chat-app.ts",
		"chat-worker": "conversation/src/http/embedded-chat-worker.ts",
	},
	outdir: outputDirectory,
	bundle: true,
	packages: "external",
	platform: "node",
	format: "esm",
	outExtension: { ".js": ".mjs" },
	target: "node22",
	alias: aliases,
});

await copyFile("chat/runtime-types/chat-server.d.ts", resolve(outputDirectory, "chat-server.d.ts"));
await copyFile("chat/runtime-types/chat-worker.d.ts", resolve(outputDirectory, "chat-worker.d.ts"));
