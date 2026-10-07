import { readFileSync } from "node:fs";

const featureListUrl = new URL("../features/cucumber-features.txt", import.meta.url);

const cucumberFeaturePaths = readFileSync(featureListUrl, "utf8")
	.split("\n")
	.map((line) => line.trim())
	.filter((line) => line !== "" && !line.startsWith("#"))
	.map((line) => `../${line}`);

export default {
	paths: cucumberFeaturePaths,
	import: ["features-support/**/*.ts"],
	format: ["progress", "summary"],
	parallel: 4,
};
