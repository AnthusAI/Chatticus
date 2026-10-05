import { readFileSync } from "node:fs";

const manifestUrl = new URL("../features/ported-features.txt", import.meta.url);

const portedFeaturePaths = readFileSync(manifestUrl, "utf8")
	.split("\n")
	.map((line) => line.trim())
	.filter((line) => line !== "" && !line.startsWith("#"))
	.map((line) => `../${line}`);

export default {
	paths: portedFeaturePaths,
	import: ["features-support/**/*.ts"],
	format: ["progress"],
};
