import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const hostDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(hostDirectory, "..", "..");
const outputDirectory = process.env["CHATTICUS_HOST_BUNDLE_DIR"] ?? resolve(hostDirectory, "dist");

await build({
	entryPoints: {
		"host-worker": resolve(hostDirectory, "src", "main.ts"),
		snapshot: resolve(repositoryRoot, "conversation", "bin", "snapshot.ts"),
	},
	outdir: outputDirectory,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	target: "node22",
	format: "esm",
	banner: {
		js: "import { createRequire as createRequireForBundle } from 'node:module'; const require = createRequireForBundle(import.meta.url);",
	},
	logLevel: "info",
});
